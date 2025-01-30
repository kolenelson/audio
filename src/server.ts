import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fetch from 'node-fetch';

// Type definitions
interface AudioConfig {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
}

interface StreamSession {
    openaiWs: WebSocket;
    twilioWs: WebSocket;
    streamSid: string;
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

// Server setup
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// Session management
const sessions = new Map<string, StreamSession>();

// Utility Functions
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
                modalities: ["audio", "text"]
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

async function initializeOpenAIWebSocket(streamSid: string, twilioWs: WebSocket): Promise<void> {
    try {
        const token = await getEphemeralToken();
        const ws = new WebSocket('wss://api.openai.com/v1/realtime', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const session: StreamSession = {
            openaiWs: ws,
            twilioWs,
            streamSid,
            mediaChunkCounter: 0
        };

        sessions.set(streamSid, session);

        ws.on('open', () => {
            console.log(`OpenAI WebSocket connected for stream ${streamSid}`);
            ws.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: "You are a helpful AI assistant."
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

        ws.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });

    } catch (error) {
        console.error('Error initializing OpenAI WebSocket:', error);
        throw error;
    }
}

function handleOpenAIMessage(message: any, session: StreamSession) {
    if (message.type === 'response.audio.delta' && message.delta) {
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
    } else if (message.type === 'error') {
        console.error('OpenAI error:', message.error);
    }
}

function handleTwilioAudio(session: StreamSession, audioBuffer: Buffer) {
    try {
        const convertedAudio = resampleAudio(
            audioBuffer,
            TWILIO_AUDIO_CONFIG.sampleRate,
            OPENAI_AUDIO_CONFIG.sampleRate
        );

        if (session.openaiWs.readyState === WebSocket.OPEN) {
            session.openaiWs.send(JSON.stringify({
                type: "audio",
                audio: convertedAudio.toString('base64')
            }));
        }
    } catch (error) {
        console.error('Error processing Twilio audio:', error);
    }
}

function cleanupSession(session: StreamSession) {
    if (session.openaiWs.readyState === WebSocket.OPEN) {
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
                        await initializeOpenAIWebSocket(data.streamSid, ws);
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
                            handleTwilioAudio(session, audioBuffer);
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

// Start server
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
