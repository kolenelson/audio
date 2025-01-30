import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { RTCPeerConnection, MediaStream, nonstandard } from 'wrtc';
import fetch from 'node-fetch';

const { RTCAudioSource, RTCAudioSink } = nonstandard;

// Types
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

        const session: StreamSession = {
            peerConnection: pc,
            dataChannel: dc,
            audioSource,
            twilioWs,
            streamSid,
            mediaChunkCounter: 0
        };

        // Handle incoming tracks from OpenAI
        pc.ontrack = (event) => {
            if (event.track.kind === 'audio') {
                console.log('Received audio track from OpenAI');
                const audioSink = new RTCAudioSink(event.track);
                session.audioSink = audioSink;
                
                audioSink.ondata = (frame) => {
                    if (!frame.samples || !frame.sampleRate) return;
                    
                    try {
                        const convertedAudio = resampleAudio(
                            Buffer.from(frame.samples.buffer),
                            frame.sampleRate,
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
                    } catch (error) {
                        console.error('Error processing OpenAI audio frame:', error);
                    }
                };
            }
        };

        // Set up data channel event handlers
        dc.onopen = () => {
            console.log('Data channel opened with OpenAI');
            dc.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: "You are a helpful AI assistant."
                }
            }));
        };

        dc.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('Received OpenAI event:', data.type);
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        };

        // Initialize WebRTC connection
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
        return session;
    } catch (error) {
        console.error('Error initializing WebRTC:', error);
        throw error;
    }
}

async function handleTwilioAudio(session: StreamSession, audioBuffer: Buffer) {
    try {
        const convertedAudio = resampleAudio(
            audioBuffer,
            TWILIO_AUDIO_CONFIG.sampleRate,
            OPENAI_AUDIO_CONFIG.sampleRate
        );

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
                            await handleTwilioAudio(session, audioBuffer);
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
        for (const session of sessions.values()) {
            if (session.twilioWs === ws) {
                if (session.audioSink) {
                    session.audioSink.stop();
                }
                session.peerConnection.close();
                sessions.delete(session.streamSid);
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
