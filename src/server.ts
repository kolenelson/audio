import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import OpenAI from 'openai';

// Extended interfaces
interface ExtendedWebSocket extends WebSocket {
    isAlive: boolean;
}

interface WebSocketMessage {
    type?: string;
    event?: string;
    streamSid?: string;
    media?: {
        payload: string;
        chunk: number;
        timestamp: string;
    };
    mark?: {
        name: string;
    };
}

interface StreamSession {
    openaiStream: any; // OpenAI Audio stream instance
    conversation: OpenAI.Chat.ChatCompletionMessageParam[];
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Track active streaming sessions
const streamingSessions = new Map<string, StreamSession>();

wss.on('connection', (ws: WebSocket) => {
    const extWs = ws as ExtendedWebSocket;
    console.log('New WebSocket connection established');

    extWs.isAlive = true;
    extWs.on('pong', () => {
        extWs.isAlive = true;
    });

    extWs.on('message', async (message: string) => {
        try {
            const data: WebSocketMessage = JSON.parse(message);
            console.log('Received message event:', data.event || data.type);

            switch (data.event || data.type) {
                case 'start':
                    if (data.streamSid) {
                        console.log('Starting new stream session:', data.streamSid);
                        
                        // Initialize OpenAI real-time stream
                        const openaiStream = await openai.audio.stream();
                        
                        // Configure handlers for OpenAI stream
                        openaiStream.on('text', (text: string) => {
                            console.log('Received text from OpenAI:', text);
                            // Handle real-time transcription
                        });

                        openaiStream.on('speech', (audio: Buffer) => {
                            console.log('Received audio response from OpenAI');
                            // Send audio back through Twilio WebSocket
                            const base64Audio = audio.toString('base64');
                            extWs.send(JSON.stringify({
                                event: 'media',
                                streamSid: data.streamSid,
                                media: {
                                    payload: base64Audio
                                }
                            }));
                        });

                        // Store session
                        streamingSessions.set(data.streamSid, {
                            openaiStream,
                            conversation: [{
                                role: 'system',
                                content: 'You are a helpful assistant having a phone conversation. Keep responses concise and natural.'
                            }]
                        });
                    }
                    break;

                case 'media':
                    if (data.streamSid && data.media?.payload) {
                        const session = streamingSessions.get(data.streamSid);
                        if (session) {
                            // Send audio chunk to OpenAI stream
                            const audioChunk = Buffer.from(data.media.payload, 'base64');
                            await session.openaiStream.write(audioChunk);
                        }
                    }
                    break;

                case 'stop':
                    if (data.streamSid) {
                        console.log('Stopping stream session:', data.streamSid);
                        const session = streamingSessions.get(data.streamSid);
                        if (session) {
                            await session.openaiStream.close();
                            streamingSessions.delete(data.streamSid);
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

// Keepalive interval
const interval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
        const extWs = ws as ExtendedWebSocket;
        if (extWs.isAlive === false) return extWs.terminate();
        extWs.isAlive = false;
        extWs.ping();
    });
}, 30000);

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
