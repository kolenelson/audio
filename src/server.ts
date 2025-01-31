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

function resampleAudio(input: Buffer, fromRate: number, toRate: number): Float32Array {
    // Convert input buffer to Float32Array
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

    return output;
}

async function sendAudioToTwilio(session: StreamSession, audioBuffer: Buffer) {
    try {
        // Make sure we have audio data
        if (!audioBuffer || audioBuffer.length === 0) {
            debugLog('Empty audio buffer received');
            return;
        }

        // Convert from OpenAI's 24kHz to Twilio's 8kHz
        const resampled = resampleAudio(
            audioBuffer,
            OPENAI_AUDIO_CONFIG.sampleRate,
            TWILIO_AUDIO_CONFIG.sampleRate
        );

        // Convert to PCM16 format for Twilio
        const pcm16Buffer = Buffer.alloc(resampled.length * 2);
        for (let i = 0; i < resampled.length; i++) {
            const sample = Math.max(-1, Math.min(1, resampled[i]));
            pcm16Buffer.writeInt16LE(Math.floor(sample * 32767), i * 2);
        }

        // Split into Twilio-sized chunks (160 bytes = 20ms at 8kHz)
        for (let offset = 0; offset < pcm16Buffer.length; offset += 160) {
            const chunk = pcm16Buffer.slice(offset, Math.min(offset + 160, pcm16Buffer.length));
            
            // Only send complete chunks
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
                    await session.twilioWs.send(JSON.stringify(twilioMessage));
                    
                    // Use a precise delay for 20ms chunks
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
            }
        }
    } catch (error) {
        console.error('Error sending audio to Twilio:', error);
    }
}

async function handleOpenAIMessage(data: OpenAIMessage, session: StreamSession) {
    debugLog('Received OpenAI event:', data.type);

    try {
        switch (data.type) {
            case 'response.audio.delta':
                if (data.delta) {
                    const audioBuffer = Buffer.from(data.delta, 'base64');
                    if (session.isStreamingAudio) {
                        await sendAudioToTwilio(session, audioBuffer);
                    }
                }
                break;

            case 'output_audio_buffer.audio_started':
                debugLog('OpenAI audio streaming started');
                session.isStreamingAudio = true;
                break;

            case 'output_audio_buffer.audio_stopped':
                debugLog('OpenAI audio streaming stopped');
                session.isStreamingAudio = false;
                break;

            case 'response.audio_transcript.delta':
                debugLog('Transcript delta:', data.delta);
                break;

            case 'error':
                console.error('OpenAI error:', data.error);
                break;

            default:
                debugLog(`Unhandled OpenAI event type: ${data.type}`);
        }
    } catch (error) {
        console.error('Error handling OpenAI message:', error);
    }
}

async function handleTwilioAudio(session: StreamSession, audioBuffer: Buffer) {
    try {
        const resampled = resampleAudio(
            audioBuffer,
            TWILIO_AUDIO_CONFIG.sampleRate,
            OPENAI_AUDIO_CONFIG.sampleRate
        );

        session.audioSource.onData({
            samples: resampled,
            sampleRate: OPENAI_AUDIO_CONFIG.sampleRate,
            channels: 1,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Error processing Twilio audio:', error);
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

            (pc as any).ontrack = (event: WrtcRTCTrackEvent) => {
                if (event.track.kind === 'audio') {
                    debugLog('Received audio track from OpenAI');
                    const audioSink = new RTCAudioSink(event.track);
                    session.audioSink = audioSink;
                    
                    audioSink.ondata = (frame: AudioFrame) => {
                        if (!frame.samples || !frame.sampleRate) return;
                        if (!session.isStreamingAudio) return;

                        try {
                            // Convert the audio frame to a buffer
                            const frameBuffer = Buffer.from(frame.samples.buffer);
                            
                            // Process and send immediately
                            sendAudioToTwilio(session, frameBuffer).catch(error => {
                                console.error('Error sending audio frame:', error);
                            });
                        } catch (error) {
                            console.error('Error processing OpenAI audio frame:', error);
                        }
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
