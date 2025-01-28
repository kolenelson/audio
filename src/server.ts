import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketMessage } from './types/websocket';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// WebSocket connection handling
wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket connection established');

  ws.on('message', async (message: string) => {
    try {
      const data: WebSocketMessage = JSON.parse(message);
      console.log('Received message type:', data.type);

      switch (data.type) {
        case 'start':
          console.log('Starting new stream:', data.streamSid);
          // Handle stream start
          break;

        case 'media':
          if (data.media?.payload) {
            console.log('Received media chunk:', data.media.chunk);
            // Handle media data
          }
          break;

        case 'stop':
          console.log('Stopping stream:', data.streamSid);
          // Handle stream stop
          break;

        default:
          console.warn('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
