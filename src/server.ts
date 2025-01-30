import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import wrtc from 'wrtc';
import fetch from 'node-fetch';
import { config } from 'dotenv';

const { RTCPeerConnection, MediaStream } = wrtc;
const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;
config();

// Type definitions
interface AudioConfig {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
}

interface StreamSession {
    peerConnection: RTCPeerConnection;
    dataChannel: RTCDataChannel;
    audioSource: InstanceType<typeof RTCAudioSource>;
    audioSink?: InstanceType<typeof RTCAudioSink>;
    twilioWs: WebSocket;
    streamSid: string;
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
    sampleRate: 24000,  // OpenAI expects 24kHz
    channels: 1,
    bitsPerSample: 16
};

const AUDIO_CONFIG = {
    twilioChunkSize: 160,  // Twilio's chunk size (8kHz * 0.02s)
    openaiChunkSize: 480,  // OpenAI's chunk size (24kHz * 0.02s)
    processingInterval: 20  // 20ms chunks
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
        
        // Type guard to verify the response shape
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
    // Convert input buffer to Float32Array
    const inputArray = new Float32Array(input.length / 2);
    for (let i = 0; i < inputArray.length; i++) {
        inputArray[i] = input.readInt16LE(i * 2) / 32768.0;
    }

    // Calculate resampling parameters
    const ratio = fromRate / toRate;
    const outputLength = Math.floor(inputArray.length * (toRate / fromRate));
    const output = new Float32Array(outputLength);

    // Perform linear interpolation resampling
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

    // Convert back to 16-bit PCM
    const outputBuffer = Buffer.alloc(output.length * 2);
    for (let i = 0; i < output.length; i++) {
        const sample = Math.max(-1, Math.min(1, output[i]));
        outputBuffer.writeInt16LE(Math.round(sample * 32767), i * 2);
    }

    return outputBuffer;
}

async function initializeWebRTC(streamSid: string, twilioWs: WebSocket): Promise<StreamSession> {
    try {
        const ephemeralKey = await getEphemeralToken();
        
        // Create peer connection
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Set up audio source for sending audio to OpenAI
        const audioSource = new RTCAudioSource();
        const audioTrack = audioSource.createTrack();
        pc.addTrack(audioTrack);

        // Create data channel for events
        const dc = pc.createDataChannel("oai-events", {
            ordered: true
        });

        // Create session object
        const session: StreamSession = {
            peerConnection: pc,
            dataChannel: dc,
            audioSource,
            twilioWs,
            streamSid,
            audioBuffer: [],
            isProcessing: false,
            mediaChunkCounter: 0
        };

        // Set up data channel handlers
        dc.onopen = () => {
            console.log('Data channel opened with OpenAI');
            // Send initial configuration
            const responseCreate = {
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: "You are a helpful AI assistant. Respond verbally to the user's questions."
                }
            };
            dc.send(JSON.stringify(responseCreate));
        };

        dc.onmessage = (event) => handleOpenAIMessage(JSON.parse(event.data), session);

        // Handle incoming audio from OpenAI
        pc.ontrack = (event) => {
            if (event.track.kind === 'audio') {
                console.log('Received audio track from OpenAI');
                const audioSink = new RTCAudioSink(event.track);
                session.audioSink = audioSink;
                
                audioSink.ondata = (frame) => {
                    if (!frame.samples || !frame.sampleRate) return;
                    handleOpenAIAudio(frame, session);
                };
            }
        };

        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const response = await fetch(
            `https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`,
            {
                method: "POST",
                body: offer.sdp,
                headers: {
                    Authorization: `Bearer ${ephemeralKey}`,
                    "Content-Type": "application/sdp"
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
        return session;

    } catch (error) {
        console.error('Error initializing WebRTC:', error);
        throw error;
    }
}

function handleOpenAIMessage(message: any, session: StreamSession) {
    console.log('Received OpenAI message:', message.type);
    
    switch (message.type) {
        case 'response.created':
            console.log('Response created:', message.response?.id);
            break;
            
        case 'response.text.delta':
            console.log('Text delta:', message.delta);
            break;
            
        case 'response.audio_transcript.delta':
            console.log('Transcript delta:', message.delta);
            break;
            
        case 'response.done':
            console.log('Response completed');
            break;
            
        case 'error':
            console.error('OpenAI error:', message.error);
            break;
    }
}

function handleOpenAIAudio(frame: { samples: Float32Array; sampleRate: number }, session: StreamSession) {
    try {
        // Convert from OpenAI's format to Twilio's format
        const convertedAudio = resampleAudio(
            Buffer.from(frame.samples.buffer),
            frame.sampleRate,
            TWILIO_AUDIO_CONFIG.sampleRate
        );

        // Split into Twilio-sized chunks
        for (let offset = 0; offset < convertedAudio.length; offset += AUDIO_CONFIG.twilioChunkSize) {
            const chunk = convertedAudio.slice(
                offset,
                Math.min(offset + AUDIO_CONFIG.twilioChunkSize, convertedAudio.length)
            );

            if (chunk.length === AUDIO_CONFIG.twilioChunkSize) {
                const message: TwilioMediaMessage = {
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
                    session.twilioWs.send(JSON.stringify(message));
                }
            }
        }
    } catch (error) {
        console.error('Error handling OpenAI audio:', error);
    }
}

async function processTwilioAudio(session: StreamSession, audioBuffer: Buffer) {
    try {
        // Convert from Twilio's format to OpenAI's format
        const convertedAudio = resampleAudio(
            audioBuffer,
            TWILIO_AUDIO_CONFIG.sampleRate,
            OPENAI_AUDIO_CONFIG.sampleRate
        );

        // Send to OpenAI
        session.audioSource.onData({
            samples: new Float32Array(convertedAudio.buffer),
            sampleRate: OPENAI_AUDIO_CONFIG.sampleRate,
            channels: 1,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Error processing Twilio audio:', error);
    }
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
                        await initializeWebRTC(data.streamSid, ws);
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
                            await processTwilioAudio(session, audioBuffer);
                        }
                    }
                    break;

                case 'stop':
                    if (data.streamSid) {
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
            }
        } catch (error) {
            console.error('Error processing Twilio message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Twilio connection closed');
        // Clean up associated sessions
        for (const [streamSid, session] of sessions.entries()) {
            if (session.twilioWs === ws) {
                if (session.audioSink) {
                    session.audioSink.stop();
                }
                session.peerConnection.close();
                sessions.delete(streamSid);
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
