import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// Extend WebSocket type to include our custom properties
interface ExtendedWebSocket extends WebSocket {
    isAlive: boolean;
}

// Update WebSocketMessage interface
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

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// Keep track of active connections
const connections = new Map<string, ExtendedWebSocket>();

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

wss.on('connection', (ws: WebSocket) => {
    const extWs = ws as ExtendedWebSocket;
    console.log('New WebSocket connection established');

    // Set up connection keepalive
    extWs.isAlive = true;
    extWs.on('pong', () => {
        extWs.isAlive = true;
    });

    // Send initial mark message to Twilio
    const mark = {
        event: 'mark',
        streamSid: 'initial',
        mark: {
            name: 'connected'
        }
    };
    extWs.send(JSON.stringify(mark));

    extWs.on('message', async (message: string) => {
        try {
            const data: WebSocketMessage = JSON.parse(message);
            console.log('Received message event:', data.event || data.type);

            switch (data.event || data.type) {
                case 'start':
                    console.log('Stream starting:', data.streamSid);
                    if (data.streamSid) {
                        connections.set(data.streamSid, extWs);
                        extWs.send(JSON.stringify({
                            event: 'mark',
                            streamSid: data.streamSid,
                            mark: { name: 'start' }
                        }));
                    }
                    break;

                case 'media':
                    if (data.media?.payload) {
                        console.log('Media chunk received:', {
                            streamSid: data.streamSid,
                            timestamp: data.media.timestamp
                        });
                        if (data.streamSid) {
                            extWs.send(JSON.stringify({
                                event: 'mark',
                                streamSid: data.streamSid,
                                mark: { name: 'alive' }
                            }));
                        }
                    }
                    break;

                case 'stop':
                    console.log('Stream stopping:', data.streamSid);
                    if (data.streamSid) {
                        connections.delete(data.streamSid);
                    }
                    break;

                default:
                    console.log('Unknown message:', data);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    extWs.on('close', () => {
        console.log('WebSocket connection closed');
        // Clean up connections map
        for (const [streamSid, socket] of connections.entries()) {
            if (socket === extWs) {
                connections.delete(streamSid);
            }
        }
    });

    extWs.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Implement keepalive ping-pong
const interval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
        const extWs = ws as ExtendedWebSocket;
        if (extWs.isAlive === false) {
            console.log('Terminating inactive connection');
            return extWs.terminate();
        }
        
        extWs.isAlive = false;
        extWs.ping();
    });
}, 30000);

// Clean up on server close
wss.on('close', () => {
    clearInterval(interval);
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
