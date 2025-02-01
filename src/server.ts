import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import wrtc from 'wrtc';
import fetch from 'node-fetch';

const { RTCPeerConnection, MediaStream } = wrtc;
const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;

// Type definitions
interface AudioConfig {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
}

interface WrtcRTCTrackEvent {
    track: MediaStreamTrack;
    streams: MediaStream[];
    receiver: RTCRtpReceiver;
    transceiver: RTCRtpTransceiver;
}

interface DataChannelMessage {
    data: string;
}

interface AudioFrame {
    samples: Float32Array;
    sampleRate: number;
    channels?: number;
    timestamp?: number;
}

interface StreamSession {
    peerConnection: InstanceType<typeof RTCPeerConnection>;
    dataChannel: any;
    audioSource: InstanceType<typeof RTCAudioSource>;
    audioSink?: InstanceType<typeof RTCAudioSink>;
    twilioWs: WebSocket;
    streamSid: string;
    mediaChunkCounter: number;
    isStreamingAudio: boolean;
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

interface OpenAIMessage {
    type: string;
    delta?: string;
    error?: {
        message: string;
        type: string;
        code?: string;
    };
}

// Constants
const AUDIO_GAIN = 2.0; // Increase volume
const MIN_AUDIO_LEVEL = 0.01; // Minimum audio level to send

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

// Debug logging function
function debugLog(message: string, data?: any) {
    console.log(`[${new Date().toISOString()}] ${message}`, data ? JSON.stringify(data) : '');
}

// Utility Functions
function adjustVolume(samples: Float32Array, gain: number): Float32Array {
    const adjusted = new Float32Array(samples.length);
    let maxLevel = 0;
    
    // First pass - find max level
    for (let i = 0; i < samples.length; i++) {
        maxLevel = Math.max(maxLevel, Math.abs(samples[i]));
    }

    // Only apply gain if we have significant audio
    if (maxLevel > MIN_AUDIO_LEVEL) {
        // Calculate safe gain to avoid clipping
        const safeGain = Math.min(gain, 1.0 / maxLevel);
        
        // Apply gain
        for (let i = 0; i < samples.length; i++) {
            adjusted[i] = samples[i] * safeGain;
        }
        debugLog(`Applied audio gain: ${safeGain}, max level: ${maxLevel}`);
    } else {
        debugLog('Audio level too low, not applying gain');
        adjusted.set(samples);
    }

    return adjusted;
}

async function getEphemeralToken(): Promise<string> {
    try {
        const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
                "openai-beta": "realtime=v1"
            },
            body: JSON.stringify({
                model: "gpt-4o-mini-realtime-preview-2024-12-17",
                voice: "alloy",
                modalities: ["audio", "text"]
            }),
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
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

async function handleTwilioAudio(session: StreamSession, audioBuffer: Buffer) {
    try {
        debugLog(`Raw Twilio audio buffer: size=${audioBuffer.length}, byteLength=${audioBuffer.byteLength}`);
        
        // Create a Float32Array of exactly the right size (80 samples for 160 bytes)
        const float32Data = new Float32Array(80);  // 160 bytes / 2 bytes per sample = 80 samples
        
        // Convert PCM16 to Float32 manually
        for (let i = 0; i < 80; i++) {
            float32Data[i] = audioBuffer.readInt16LE(i * 2) / 32768.0;
        }
        
        debugLog(`Created Float32Array: samples=${float32Data.length}, byteLength=${float32Data.byteLength}`);

        session.audioSource.onData({
            samples: float32Data,
            sampleRate: TWILIO_AUDIO_CONFIG.sampleRate,
            channels: 1,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Error details:', {
            error: error instanceof Error ? error.message : String(error),
            bufferSize: audioBuffer ? audioBuffer.length : 'no buffer',
            bufferType: audioBuffer ? audioBuffer.constructor.name : 'no buffer'
        });
    }
}

async function sendAudioToTwilio(session: StreamSession, audioBuffer: Buffer) {
    try {
        debugLog(`Received OpenAI audio buffer of size: ${audioBuffer.length}`);

        // Convert to 8kHz PCM16
        const samples = audioBuffer.length / 2;
        const ratio = OPENAI_AUDIO_CONFIG.sampleRate / TWILIO_AUDIO_CONFIG.sampleRate;
        const outputLength = Math.floor(samples / ratio);
        const outputBuffer = Buffer.alloc(outputLength * 2);

        for (let i = 0; i < outputLength; i++) {
            const inputIndex = Math.floor(i * ratio) * 2;
            const sample = audioBuffer.readInt16LE(inputIndex);
            outputBuffer.writeInt16LE(sample, i * 2);
        }

        // Send in 160-byte chunks
        for (let offset = 0; offset < outputBuffer.length; offset += 160) {
            const chunk = outputBuffer.slice(offset, Math.min(offset + 160, outputBuffer.length));
            if (chunk.length === 160) {
                const twilioMessage: TwilioMediaMessage = {
                    event: 'media',
                    streamSid: session.streamSid,
                    media: {
                        payload: chunk.toString('base64'),
                        track: 'outbound',
                        chunk: session.mediaChunkCounter++,
                        timestamp: new Date().toISOString()
                    }
                };

                if (session.twilioWs.readyState === WebSocket.OPEN) {
                    debugLog(`Sending audio chunk ${session.mediaChunkCounter - 1} to Twilio (${chunk.length} bytes)`);
                    session.twilioWs.send(JSON.stringify(twilioMessage));
                }
            }
        }
    } catch (error) {
        console.error('Error sending audio to Twilio:', error);
    }
}

function initializeWebRTC(streamSid: string, twilioWs: WebSocket): Promise<StreamSession> {
    return new Promise(async (resolve, reject) => {
        try {
            const ephemeralKey = await getEphemeralToken();
            
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });

            const audioSource = new RTCAudioSource();
            const audioTrack = audioSource.createTrack();
            pc.addTrack(audioTrack);

            const dc = pc.createDataChannel("oai-events", {
                ordered: true
            });

            const session: StreamSession = {
                peerConnection: pc,
                dataChannel: dc,
                audioSource,
                twilioWs,
                streamSid,
                mediaChunkCounter: 0,
                isStreamingAudio: false
            };

            // Set up event handlers
            pc.oniceconnectionstatechange = () => {
                debugLog('ICE connection state changed:', pc.iceConnectionState);
            };

            pc.onconnectionstatechange = () => {
                debugLog('Connection state changed:', pc.connectionState);
            };

            // Handle incoming audio from OpenAI
(pc as any).ontrack = (event: WrtcRTCTrackEvent) => {
    if (event.track.kind === 'audio') {
        debugLog('Received audio track from OpenAI');
        const audioSink = new RTCAudioSink(event.track);
        session.audioSink = audioSink;
        
        audioSink.ondata = (frame: AudioFrame) => {
            if (!frame.samples || !frame.sampleRate) return;
            if (!session.isStreamingAudio) return;

            // Convert samples to buffer
            const audioBuffer = Buffer.from(frame.samples.buffer);
            sendAudioToTwilio(session, audioBuffer).catch(error => {
                console.error('Error sending audio frame:', error);
            });
        };
    }
};

            dc.onopen = () => {
                debugLog('Data channel opened with OpenAI');
                dc.send(JSON.stringify({
                    type: "response.create",
                    response: {
                        modalities: ["text", "audio"],
                        instructions: "You are a helpful AI assistant. Keep your responses concise and natural."
                    }
                }));
            };

            dc.onmessage = (event: DataChannelMessage) => {
                try {
                    const data = JSON.parse(event.data);
                    handleOpenAIMessage(data, session);
                } catch (error) {
                    console.error('Error processing OpenAI message:', error);
                }
            };

            // Create and send offer
            const offer = await pc.createOffer({
                offerToReceiveAudio: true
            });
            await pc.setLocalDescription(offer);

            const response = await fetch(
                `https://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17`,
                {
                    method: "POST",
                    body: offer.sdp,
                    headers: {
                        Authorization: `Bearer ${ephemeralKey}`,
                        "Content-Type": "application/sdp",
                        "openai-beta": "realtime=v1"
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`OpenAI SDP error: ${response.status} ${response.statusText}`);
            }

            const sdpAnswer = await response.text();
            await pc.setRemoteDescription({
                type: "answer",
                sdp: sdpAnswer
            });

            sessions.set(streamSid, session);
            resolve(session);

        } catch (error) {
            console.error('Error initializing WebRTC:', error);
            reject(error);
        }
    });
}

// WebSocket server handler
wss.on('connection', (ws: WebSocket) => {
    debugLog('New Twilio connection established');

    ws.on('message', async (message: Buffer) => {
        try {
            const data = JSON.parse(message.toString());
            
            switch (data.event) {
                case 'start':
                    if (data.streamSid) {
                        debugLog('Starting new stream session:', data.streamSid);
                        const session = await initializeWebRTC(data.streamSid, ws);
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
                        debugLog('Stopping stream session:', data.streamSid);
                        const session = sessions.get(data.streamSid);
                        if (session) {
                            if (session.audioSink) {
                                session.audioSink.stop();
                            }
                            session.peerConnection.close();
                            sessions.delete(data.streamSid);
                            
                            ws.send(JSON.stringify({
                                event: 'mark',
                                streamSid: data.streamSid,
                                mark: { name: 'disconnected' }
                            }));
                        }
                    }
                    break;

                default:
                    debugLog('Unhandled Twilio event:', data.event);
            }
        } catch (error) {
            console.error('Error processing Twilio message:', error);
        }
    });

    ws.on('close', () => {
        debugLog('Twilio connection closed');
        // Clean up associated sessions
        for (const [streamSid, session] of sessions.entries()) {
            if (session.twilioWs === ws) {
                debugLog('Cleaning up session:', streamSid);
                if (session.audioSink) {
                    session.audioSink.stop();
                }
                session.peerConnection.close();
                sessions.delete(streamSid);
            }
        }
    });

    ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Start server
server.listen(PORT, () => {
    debugLog(`Server is running on port ${PORT}`);
});
