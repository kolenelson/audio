import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fetch from 'node-fetch';
import { 
    RTCPeerConnection, 
    MediaStream, 
    RTCAudioSink,
    RTCAudioSource,
    nonstandard,
    RTCAudioData
} from 'wrtc';
import dotenv from 'dotenv';

dotenv.config();

// Interfaces
interface ExtendedWebSocket extends WebSocket {
    isAlive: boolean;
}

interface AudioConfig {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
}

interface AudioSession {
    audioSource: RTCAudioSource;
    audioSink: RTCAudioSink;
    bufferQueue: Buffer[];
    isProcessing: boolean;
    twilioWs: WebSocket;
    mediaChunkCounter: number;
}

interface StreamSession {
    peerConnection: RTCPeerConnection;
    dataChannel: RTCDataChannel;
    audioTransceiver: RTCRtpTransceiver;
    audioSession: AudioSession;
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

interface OpenAIResponse {
    client_secret: {
        value: string;
    };
}

// Constants
const TWILIO_AUDIO_CONFIG: AudioConfig = {
    sampleRate: 8000,
    channels: 1,
    bitsPerSample: 16
};

const WEBRTC_AUDIO_CONFIG: AudioConfig = {
    sampleRate: 48000,
    channels: 1,
    bitsPerSample: 16
};

const AUDIO_CONFIG = {
    chunkSize: 320,
    processingInterval: 20,
    maxQueueSize: 50
};

// Server setup
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// Track active sessions
const streamingSessions = new Map<string, StreamSession>();

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Utility Functions
async function getEphemeralToken(): Promise<string> {
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "gpt-4o-realtime-preview-2024-12-17",
            voice: "verse",
        }),
    });
    const data = await response.json() as OpenAIResponse;
    return data.client_secret.value;
}

function convertAudioFormat(
    samples: Float32Array,
    fromConfig: AudioConfig,
    toConfig: AudioConfig
): Buffer {
    const resampledData = resampleAudio(samples, fromConfig.sampleRate, toConfig.sampleRate);
    const buffer = Buffer.alloc(resampledData.length * (toConfig.bitsPerSample / 8));
    
    for (let i = 0; i < resampledData.length; i++) {
        const sample = Math.max(-1, Math.min(1, resampledData[i]));
        const value = Math.floor(sample * ((1 << (toConfig.bitsPerSample - 1)) - 1));
        if (toConfig.bitsPerSample === 16) {
            buffer.writeInt16LE(value, i * 2);
        }
    }
    return buffer;
}

function resampleAudio(
    samples: Float32Array,
    fromRate: number,
    toRate: number
): Float32Array {
    const ratio = fromRate / toRate;
    const newLength = Math.floor(samples.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
        const pos = i * ratio;
        const index = Math.floor(pos);
        const fraction = pos - index;

        if (index + 1 < samples.length) {
            result[i] = samples[index] * (1 - fraction) + samples[index + 1] * fraction;
        } else {
            result[i] = samples[index];
        }
    }
    return result;
}

async function initializeWebRTC(streamSid: string, twilioWs: WebSocket): Promise<StreamSession> {
    const ephemeralKey = await getEphemeralToken();
    
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const audioSource = new nonstandard.RTCAudioSource();
    const audioTrack = audioSource.createTrack();
    
    const audioTransceiver = pc.addTransceiver(audioTrack, {
        direction: 'sendrecv'
    });

    const dc = pc.createDataChannel("oai-events", {
        ordered: true
    });

    const audioSink = new RTCAudioSink(audioTransceiver.receiver.track);

    const audioSession: AudioSession = {
        audioSource,
        audioSink,
        bufferQueue: [],
        isProcessing: false,
        twilioWs,
        mediaChunkCounter: 0
    };

    audioSink.ondata = (frame: RTCAudioData) => {
        if (!frame.samples || !frame.sampleRate) return;

        try {
            const convertedAudio = convertAudioFormat(
                frame.samples,
                { sampleRate: frame.sampleRate, channels: frame.channels || 1, bitsPerSample: 16 },
                TWILIO_AUDIO_CONFIG
            );

            const twilioMessage: TwilioMediaMessage = {
                event: 'media',
                streamSid: streamSid,
                media: {
                    payload: convertedAudio.toString('base64'),
                    track: 'outbound',
                    chunk: audioSession.mediaChunkCounter++,
                    timestamp: new Date().toISOString()
                }
            };

            if (audioSession.twilioWs.readyState === WebSocket.OPEN) {
                audioSession.twilioWs.send(JSON.stringify(twilioMessage));
            }
        } catch (error) {
            console.error('Error sending audio to Twilio:', error);
        }
    };

    // Initialize WebRTC connection
    const offer = await pc.createOffer({
        offerToReceiveAudio: true
    });
    await pc.setLocalDescription(offer);

    try {
        const response = await fetch(`https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`, {
            method: "POST",
            body: offer.sdp,
            headers: {
                Authorization: `Bearer ${ephemeralKey}`,
                "Content-Type": "application/sdp"
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const answer: RTCSessionDescriptionInit = {
            type: "answer",
            sdp: await response.text()
        };
    await pc.setRemoteDescription(answer);

    return {
        peerConnection: pc,
        dataChannel: dc,
        audioTransceiver,
        audioSession
    };
}

// WebSocket Connection Handler
wss.on('connection', async (ws: WebSocket) => {
    const extWs = ws as ExtendedWebSocket;
    console.log('New WebSocket connection established');

    extWs.isAlive = true;
    extWs.on('pong', () => {
        extWs.isAlive = true;
    });

    extWs.on('message', async (message: string) => {
        try {
            const data = JSON.parse(message) as {
                event?: string;
                type?: string;
                streamSid?: string;
                media?: {
                    payload: string;
                };
            };
            
            console.log('Received message event:', data.event || data.type);

            switch (data.event || data.type) {
                case 'start':
                    if (data.streamSid) {
                        console.log('Starting new stream session:', data.streamSid);
                        const session = await initializeWebRTC(data.streamSid, extWs);
                        streamingSessions.set(data.streamSid, session);

                        extWs.send(JSON.stringify({
                            event: 'mark',
                            streamSid: data.streamSid,
                            mark: { name: 'connected' }
                        }));
                    }
                    break;

                case 'media':
                    if (data.streamSid && data.media?.payload) {
                        const session = streamingSessions.get(data.streamSid);
                        if (session?.audioSession) {
                            const audioBuffer = Buffer.from(data.media.payload, 'base64');
                            session.audioSession.bufferQueue.push(audioBuffer);

                            if (session.audioSession.bufferQueue.length > AUDIO_CONFIG.maxQueueSize) {
                                session.audioSession.bufferQueue = 
                                    session.audioSession.bufferQueue.slice(-AUDIO_CONFIG.maxQueueSize);
                            }

                            if (!session.audioSession.isProcessing) {
                                processAudioQueue(session.audioSession);
                            }
                        }
                    }
                    break;

                case 'stop':
                    if (data.streamSid) {
                        console.log('Stopping stream session:', data.streamSid);
                        const session = streamingSessions.get(data.streamSid);
                        if (session) {
                            session.audioSession.bufferQueue = [];
                            session.audioSession.isProcessing = false;
                            session.peerConnection.close();
                            streamingSessions.delete(data.streamSid);

                            extWs.send(JSON.stringify({
                                event: 'mark',
                                streamSid: data.streamSid,
                                mark: { name: 'disconnected' }
                            }));
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    extWs.on('close', () => {
        console.log('WebSocket connection closed');
    });

    extWs.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Audio Queue Processing
async function processAudioQueue(audioSession: AudioSession) {
    if (audioSession.isProcessing || audioSession.bufferQueue.length === 0) return;

    audioSession.isProcessing = true;

    try {
        while (audioSession.bufferQueue.length > 0) {
            const audioChunk = audioSession.bufferQueue.shift();
            if (!audioChunk) continue;

            const samples = new Float32Array(audioChunk.length / 2);
            for (let i = 0; i < samples.length; i++) {
                samples[i] = audioChunk.readInt16LE(i * 2) / 32768.0;
            }

            audioSession.audioSource.onData({
                samples,
                sampleRate: TWILIO_AUDIO_CONFIG.sampleRate,
                channels: TWILIO_AUDIO_CONFIG.channels,
                timestamp: Date.now()
            });

            await new Promise(resolve => setTimeout(resolve, AUDIO_CONFIG.processingInterval));
        }
    } finally {
        audioSession.isProcessing = false;
    }
}

// Keep-alive interval
const interval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
        const extWs = ws as ExtendedWebSocket;
        if (extWs.isAlive === false) return extWs.terminate();
        extWs.isAlive = false;
        extWs.ping();
    });
}, 30000);

// Cleanup on server close
wss.on('close', () => {
    clearInterval(interval);
});

// Start server
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
