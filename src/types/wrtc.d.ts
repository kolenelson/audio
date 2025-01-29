declare module 'wrtc' {
    interface RTCAudioData {
        samples: Float32Array;
        sampleRate: number;
        channels?: number;
        timestamp?: number;
    }

    class RTCAudioSource {
        createTrack(): MediaStreamTrack;
        onData(data: RTCAudioData): void;
    }

    class RTCAudioSink {
        constructor(track: MediaStreamTrack);
        ondata: (frame: RTCAudioData) => void;
        stop(): void;
    }

    class MediaStreamTrack {
        enabled: boolean;
        id: string;
        kind: string;
        label: string;
        muted: boolean;
        readyState: MediaStreamTrackState;
        remote: boolean;
        onended: ((this: MediaStreamTrack, ev: Event) => any) | null;
        onmute: ((this: MediaStreamTrack, ev: Event) => any) | null;
        onunmute: ((this: MediaStreamTrack, ev: Event) => any) | null;
        clone(): MediaStreamTrack;
        stop(): void;
    }

    class RTCPeerConnection {
        constructor(configuration?: RTCConfiguration);
        createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
        setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
        addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver;
        createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
        addIceCandidate(candidate: RTCIceCandidateInit | RTCIceCandidate): Promise<void>;
        addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
        close(): void;
        
        onicecandidateerror: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        ondatachannel: ((this: RTCPeerConnection, ev: RTCDataChannelEvent) => any) | null;
        onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => any) | null;
        oniceconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onicegatheringstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onnegotiationneeded: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onsignalingstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        ontrack: ((this: RTCPeerConnection, ev: RTCTrackEvent) => any) | null;
        
        readonly localDescription: RTCSessionDescription | null;
        readonly currentLocalDescription: RTCSessionDescription | null;
        readonly pendingLocalDescription: RTCSessionDescription | null;
        readonly remoteDescription: RTCSessionDescription | null;
        readonly currentRemoteDescription: RTCSessionDescription | null;
        readonly pendingRemoteDescription: RTCSessionDescription | null;
        readonly signalingState: RTCSignalingState;
        readonly iceGatheringState: RTCIceGatheringState;
        readonly iceConnectionState: RTCIceConnectionState;
        readonly connectionState: RTCPeerConnectionState;
        readonly canTrickleIceCandidates: boolean | null;
        readonly sctp: RTCSctpTransport | null;
    }

    const nonstandard: {
        RTCAudioSource: typeof RTCAudioSource;
    };

    const wrtc: {
        RTCPeerConnection: typeof RTCPeerConnection;
        MediaStreamTrack: typeof MediaStreamTrack;
        RTCAudioSink: typeof RTCAudioSink;
        nonstandard: typeof nonstandard;
    };

    export = wrtc;
}
