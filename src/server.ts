import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketMessage } from './types/websocket';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// Keep track of active connections
const connections = new Map();

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket connection established');
  
  // Set up connection keepalive
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Send initial mark message to Twilio to confirm connection
  const mark = {
    event: 'mark',
    streamSid: 'initial',
    mark: {
      name: 'connected'
    }
  };
  ws.send(JSON.stringify(mark));

  ws.on('message', async (message: string) => {
    try {
      const data: WebSocketMessage = JSON.parse(message);
      console.log('Received message event:', data.event || data.type);
      
      // Handle different Twilio Media Stream events
      switch (data.event || data.type) {
        case 'start':
          console.log('Stream starting:', data.streamSid);
          // Store the connection with its streamSid
          connections.set(data.streamSid, ws);
          // Send acknowledgment back to Twilio
          ws.send(JSON.stringify({
            event: 'mark',
            streamSid: data.streamSid,
            mark: { name: 'start' }
          }));
          break;

        case 'media':
          if (data.media?.payload) {
            console.log('Media chunk received:', {
              streamSid: data.streamSid,
              timestamp: data.media.timestamp
            });
            // Echo back a mark to keep the connection alive
            ws.send(JSON.stringify({
              event: 'mark',
              streamSid: data.streamSid,
              mark: { name: 'alive' }
            }));
          }
          break;

        case 'stop':
          console.log('Stream stopping:', data.streamSid);
          connections.delete(data.streamSid);
          break;

        default:
          console.log('Unknown message:', data);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    // Clean up connections map
    for (const [streamSid, socket] of connections.entries()) {
      if (socket === ws) {
        connections.delete(streamSid);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Implement keepalive ping-pong
const interval = setInterval(() => {
  wss.clients.forEach((ws: WebSocket) => {
    if (ws.isAlive === false) {
      console.log('Terminating inactive connection');
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Clean up on server close
wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
