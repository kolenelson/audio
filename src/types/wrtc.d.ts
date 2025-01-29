declare module 'wrtc' {
    interface WrtcMediaStreamTrack extends MediaStreamTrack {
        remote: boolean;
    }

    interface RTCAudioData {
        samples: Float32Array;
        sampleRate: number;
        channels?: number;
        timestamp?: number;
    }

    class RTCAudioSource {
        constructor();
        createTrack(): WrtcMediaStreamTrack;
        onData(data: RTCAudioData): void;
    }

    class RTCAudioSink {
        constructor(track: WrtcMediaStreamTrack);
        ondata: (frame: RTCAudioData) => void;
        stop(): void;
    }

    class RTCPeerConnection {
        constructor(configuration?: RTCConfiguration);
        createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
        setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
        addTransceiver(trackOrKind: WrtcMediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver;
        createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
        close(): void;
    }

    const nonstandard: {
        RTCAudioSource: typeof RTCAudioSource;
    };

    interface Wrtc {
        RTCPeerConnection: typeof RTCPeerConnection;
        RTCAudioSink: typeof RTCAudioSink;
        nonstandard: typeof nonstandard;
        MediaStream: typeof MediaStream;
    }

    const wrtc: Wrtc;
    export = wrtc;
}
