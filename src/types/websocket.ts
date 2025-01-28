export interface WebSocketMessage {
  type: 'start' | 'media' | 'stop';
  streamSid?: string;
  media?: {
    payload: string;
    track?: string;
    chunk?: number;
    timestamp?: number;
  };
}
