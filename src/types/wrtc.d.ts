declare module 'wrtc' {
    interface RTCAudioData {
        samples: Float32Array;
        sampleRate: number;
        channels?: number;
        timestamp?: number;
    }

    class RTCAudioSource {
        constructor();
        createTrack(): MediaStreamTrack;
        onData(data: RTCAudioData): void;
    }

    class RTCAudioSink {
        constructor(track: MediaStreamTrack);
        ondata: (frame: RTCAudioData) => void;
        stop(): void;
    }

    // Using the standard RTCPeerConnection type from lib.dom.d.ts
    const RTCPeerConnection: {
        prototype: RTCPeerConnection;
        new(configuration?: RTCConfiguration): RTCPeerConnection;
    };

    // Using the standard MediaStream type from lib.dom.d.ts
    const MediaStream: {
        prototype: MediaStream;
        new(): MediaStream;
        new(tracks: MediaStreamTrack[]): MediaStream;
        new(stream: MediaStream): MediaStream;
    };

    const nonstandard: {
        RTCAudioSource: typeof RTCAudioSource;
        RTCAudioSink: typeof RTCAudioSink;
    };

    export {
        RTCPeerConnection,
        MediaStream,
        nonstandard,
        RTCAudioData,
        RTCAudioSource,
        RTCAudioSink
    };
}
