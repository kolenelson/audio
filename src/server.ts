import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fetch from 'node-fetch';
import wrtc from 'wrtc';
import dotenv from 'dotenv';

dotenv.config();

// Extend MediaStreamTrack to include the 'remote' property
interface WrtcMediaStreamTrack extends MediaStreamTrack {
    remote: boolean;
}

// Interfaces
interface RTCTrackEvent {
    track: MediaStreamTrack;
    streams: MediaStream[];
    receiver: RTCRtpReceiver;
    transceiver: RTCRtpTransceiver;
}

interface ExtendedWebSocket extends WebSocket {
    isAlive: boolean;
}

interface AudioConfig {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
}

interface AudioSession {
    audioSource: InstanceType<typeof wrtc.nonstandard.RTCAudioSource>;
    audioSink?: InstanceType<typeof wrtc.RTCAudioSink>;  // Optional since we might not have received the track yet
    bufferQueue: Buffer[];
    isProcessing: boolean;
    twilioWs: WebSocket;
    mediaChunkCounter: number;
}

interface StreamSession {
    peerConnection: InstanceType<typeof wrtc.RTCPeerConnection>;
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

interface RTCAudioData {
    samples: Float32Array;
    sampleRate: number;
    channels?: number;
    timestamp?: number;
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
    try {
        console.log('Requesting ephemeral token from OpenAI...');
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

        if (!response.ok) {
            const errorText = await response.text();
            console.error('OpenAI API error:', {
                status: response.status,
                statusText: response.statusText,
                error: errorText
            });
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log('OpenAI response:', JSON.stringify(data, null, 2));

        if (!data || !data.client_secret || !data.client_secret.value) {
            console.error('Unexpected response format from OpenAI:', data);
            throw new Error('Invalid response format from OpenAI');
        }

        return data.client_secret.value;
    } catch (error) {
        console.error('Error getting ephemeral token:', error);
        throw error;
    }
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
    try {
        console.log('Getting ephemeral token...');
        const ephemeralKey = await getEphemeralToken();
        console.log('Got ephemeral token successfully');
        
        console.log('Creating RTCPeerConnection...');
        const pc = new wrtc.RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // ... rest of the function remains the same until the fetch request

        try {
            console.log('Sending SDP offer to OpenAI...');
            const response = await fetch(`https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`, {
                method: "POST",
                body: offer.sdp,
                headers: {
                    Authorization: `Bearer ${ephemeralKey}`,
                    "Content-Type": "application/sdp"
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('OpenAI SDP error:', {
                    status: response.status,
                    statusText: response.statusText,
                    error: errorText
                });
                throw new Error(`OpenAI SDP error: ${response.status} ${response.statusText}`);
            }

            const sdpAnswer = await response.text();
            console.log('Received SDP answer from OpenAI');

            const answer: RTCSessionDescriptionInit = {
                type: "answer",
                sdp: sdpAnswer
            };
            
            console.log('Setting remote description...');
            await pc.setRemoteDescription(answer);
            console.log('Remote description set successfully');
            
            return {
                peerConnection: pc,
                dataChannel: dc,
                audioTransceiver,
                audioSession
            };
        } catch (error) {
            console.error('Error in WebRTC setup:', error);
            pc.close();
            throw error;
        }
    } catch (error) {
        console.error('Error in initializeWebRTC:', error);
        throw error;
    }
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
                            if (session.audioSession.audioSink) {
                                session.audioSession.audioSink.stop();
                            }
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
        // Clean up any active sessions associated with this connection
        for (const [streamSid, session] of streamingSessions.entries()) {
            if (session.audioSession.twilioWs === extWs) {
                if (session.audioSession.audioSink) {
                    session.audioSession.audioSink.stop();
                }
                session.peerConnection.close();
                streamingSessions.delete(streamSid);
            }
        }
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

            const audioData: RTCAudioData = {
                samples,
                sampleRate: TWILIO_AUDIO_CONFIG.sampleRate,
                channels: TWILIO_AUDIO_CONFIG.channels,
                timestamp: Date.now()
            };

            (audioSession.audioSource as any).onData(audioData);

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
    // Clean up all active sessions
    for (const session of streamingSessions.values()) {
        if (session.audioSession.audioSink) {
            session.audioSession.audioSink.stop();
        }
        session.peerConnection.close();
    }
    streamingSessions.clear();
});

// Start server
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
