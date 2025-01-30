import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as mediasoup from 'mediasoup';
import fetch from 'node-fetch';
import { config } from 'dotenv';
import { Worker } from 'mediasoup/node/lib/Worker';
import { Router } from 'mediasoup/node/lib/Router';
import { WebRtcTransport } from 'mediasoup/node/lib/WebRtcTransport';
import { Producer } from 'mediasoup/node/lib/Producer';
import { Consumer } from 'mediasoup/node/lib/Consumer';

config();

// Type definitions
interface AudioConfig {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
}

interface StreamSession {
    worker: Worker;
    router: Router;
    transport: WebRtcTransport;
    producer?: Producer;
    consumer?: Consumer;
    twilioWs: WebSocket;
    streamSid: string;
    openaiWs?: WebSocket;
    audioBuffer: Buffer[];
    isProcessing: boolean;
    mediaChunkCounter: number;
}

interface TwilioMediaMessage {
    event: string;
    streamSid: string;
    media: {
        payload: string;
        track?: string;
        chunk?: number;
        timestamp?: string;
    };
}

interface OpenAISessionResponse {
    client_secret: {
        value: string;
        expires_at: number;
    };
}

// Audio configurations
const TWILIO_AUDIO_CONFIG: AudioConfig = {
    sampleRate: 8000,
    channels: 1,
    bitsPerSample: 16
};

const OPENAI_AUDIO_CONFIG: AudioConfig = {
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16
};

const AUDIO_CONFIG = {
    twilioChunkSize: 160,
    openaiChunkSize: 480,
    processingInterval: 20
};

// Mediasoup settings
const MEDIASOUP_SETTINGS = {
    worker: {
        rtcMinPort: 10000,
        rtcMaxPort: 10100
    },
    router: {
        mediaCodecs: [
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2
            }
        ]
    },
    webRtcTransport: {
        listenIps: [
            {
                ip: '0.0.0.0',  // Listen on all interfaces
                announcedIp: null  // Let WebRTC handle NAT traversal
            }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 800000
    }
};

// Server setup
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// Session management
const sessions = new Map<string, StreamSession>();
let worker: Worker | null = null;

// Audio processing functions
function resampleAudio(input: Buffer, fromRate: number, toRate: number): Buffer {
    const inputArray = new Float32Array(input.length / 2);
    for (let i = 0; i < inputArray.length; i++) {
        inputArray[i] = input.readInt16LE(i * 2) / 32768.0;
    }

    const ratio = fromRate / toRate;
    const outputLength = Math.floor(inputArray.length * (toRate / fromRate));
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        const position = i * ratio;
        const index = Math.floor(position);
        const fraction = position - index;

        if (index + 1 < inputArray.length) {
            output[i] = inputArray[index] * (1 - fraction) + 
                       inputArray[index + 1] * fraction;
        } else {
            output[i] = inputArray[index];
        }
    }

    const outputBuffer = Buffer.alloc(output.length * 2);
    for (let i = 0; i < output.length; i++) {
        const sample = Math.max(-1, Math.min(1, output[i]));
        outputBuffer.writeInt16LE(Math.round(sample * 32767), i * 2);
    }

    return outputBuffer;
}

// OpenAI integration
async function getEphemeralToken(): Promise<string> {
    try {
        const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-realtime-preview-2024-12-17",
                voice: "alloy",
                modalities: ["audio", "text"],
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                input_audio_transcription: {
                    model: "whisper-1"
                }
            }),
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }

        const data: unknown = await response.json();
        
        function isOpenAISessionResponse(data: unknown): data is OpenAISessionResponse {
            return (
                typeof data === 'object' && 
                data !== null && 
                'client_secret' in data &&
                typeof (data as any).client_secret === 'object' &&
                (data as any).client_secret !== null &&
                'value' in (data as any).client_secret &&
                typeof (data as any).client_secret.value === 'string'
            );
        }

        if (!isOpenAISessionResponse(data)) {
            throw new Error('Invalid response format from OpenAI');
        }

        return data.client_secret.value;
    } catch (error) {
        console.error('Error getting ephemeral token:', error);
        throw error;
    }
}

async function initializeMediasoup() {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: MEDIASOUP_SETTINGS.worker.rtcMinPort,
        rtcMaxPort: MEDIASOUP_SETTINGS.worker.rtcMaxPort
    });

    worker.on('died', () => {
        console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker?.pid);
        setTimeout(() => process.exit(1), 2000);
    });

    console.log('mediasoup worker created [pid:%d]', worker.pid);
}

async function createRouter(): Promise<Router> {
    if (!worker) {
        throw new Error('Mediasoup worker not initialized');
    }
    return await worker.createRouter({ mediaCodecs: MEDIASOUP_SETTINGS.router.mediaCodecs });
}

async function createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
    return await router.createWebRtcTransport(MEDIASOUP_SETTINGS.webRtcTransport);
}

async function handleTwilioAudio(session: StreamSession, audioBuffer: Buffer) {
    try {
        // Convert Twilio audio to OpenAI format
        const convertedAudio = resampleAudio(
            audioBuffer,
            TWILIO_AUDIO_CONFIG.sampleRate,
            OPENAI_AUDIO_CONFIG.sampleRate
        );

        if (session.producer) {
            await session.producer.send(convertedAudio);
        }
    } catch (error) {
        console.error('Error processing Twilio audio:', error);
    }
}

async function initializeSession(streamSid: string, twilioWs: WebSocket): Promise<StreamSession> {
    if (!worker) {
        throw new Error('Mediasoup worker not initialized');
    }

    const router = await createRouter();
    const transport = await createWebRtcTransport(router);

    const session: StreamSession = {
        worker,
        router,
        transport,
        twilioWs,
        streamSid,
        audioBuffer: [],
        isProcessing: false,
        mediaChunkCounter: 0
    };

    // Set up OpenAI WebSocket connection
    const token = await getEphemeralToken();
    const ws = new WebSocket('wss://api.openai.com/v1/realtime', {
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    ws.on('open', () => {
        console.log(`OpenAI WebSocket connected for stream ${streamSid}`);
        session.openaiWs = ws;

        // Send initial configuration
        ws.send(JSON.stringify({
            type: "response.create",
            response: {
                modalities: ["text", "audio"],
                instructions: "You are a helpful AI assistant. Respond verbally to the user's questions."
            }
        }));
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleOpenAIMessage(message, session);
        } catch (error) {
            console.error('Error processing OpenAI message:', error);
        }
    });

    ws.on('close', () => {
        console.log(`OpenAI WebSocket closed for stream ${streamSid}`);
        cleanupSession(session);
    });

    sessions.set(streamSid, session);
    return session;
}

function handleOpenAIMessage(message: any, session: StreamSession) {
    switch (message.type) {
        case 'response.audio.delta':
            if (message.delta) {
                const audioBuffer = Buffer.from(message.delta, 'base64');
                const convertedAudio = resampleAudio(
                    audioBuffer,
                    OPENAI_AUDIO_CONFIG.sampleRate,
                    TWILIO_AUDIO_CONFIG.sampleRate
                );

                const twilioMessage: TwilioMediaMessage = {
                    event: 'media',
                    streamSid: session.streamSid,
                    media: {
                        payload: convertedAudio.toString('base64'),
                        track: 'outbound',
                        chunk: session.mediaChunkCounter++,
                        timestamp: new Date().toISOString()
                    }
                };

                if (session.twilioWs.readyState === WebSocket.OPEN) {
                    session.twilioWs.send(JSON.stringify(twilioMessage));
                }
            }
            break;

        case 'error':
            console.error('OpenAI error:', message.error);
            break;

        default:
            console.log('Received OpenAI message:', message.type);
    }
}

function cleanupSession(session: StreamSession) {
    if (session.producer) {
        session.producer.close();
    }
    if (session.consumer) {
        session.consumer.close();
    }
    if (session.transport) {
        session.transport.close();
    }
    if (session.openaiWs) {
        session.openaiWs.close();
    }
    sessions.delete(session.streamSid);
}

// WebSocket server handler
wss.on('connection', (ws: WebSocket) => {
    console.log('New Twilio connection established');

    ws.on('message', async (message: string) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'start':
                    if (data.streamSid) {
                        await initializeSession(data.streamSid, ws);
                        ws.send(JSON.stringify({
                            event: 'mark',
                            streamSid: data.streamSid,
                            mark: { name: 'connected' }
                        }));
                    }
                    break;

                case 'media':
                    if (data.streamSid && data.media?.payload) {
                        const session = sessions.get(data.streamSid);
                        if (session) {
                            const audioBuffer = Buffer.from(data.media.payload, 'base64');
                            await handleTwilioAudio(session, audioBuffer);
                        }
                    }
                    break;

                case 'stop':
                    if (data.streamSid) {
                        const session = sessions.get(data.streamSid);
                        if (session) {
                            cleanupSession(session);
                            ws.send(JSON.stringify({
                                event: 'mark',
                                streamSid: data.streamSid,
                                mark: { name: 'disconnected' }
                            }));
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing Twilio message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Twilio connection closed');
        // Clean up any sessions associated with this connection
        for (const session of sessions.values()) {
            if (session.twilioWs === ws) {
                cleanupSession(session);
            }
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Initialize mediasoup and start server
async function start() {
    await initializeMediasoup();
    
    server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

start().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
