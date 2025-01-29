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

    interface RTCTrackEvent {
        track: MediaStreamTrack;
        streams: MediaStream[];
        receiver: RTCRtpReceiver;
        transceiver: RTCRtpTransceiver;
    }

    class RTCPeerConnection {
        constructor(configuration?: RTCConfiguration);
        createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
        setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
        addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver;
        createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
        close(): void;
        
        // Event handlers
        onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        ondatachannel: ((this: RTCPeerConnection, ev: RTCDataChannelEvent) => any) | null;
        onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => any) | null;
        onicecandidateerror: ((this: RTCPeerConnection, ev: Event) => any) | null;
        oniceconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onicegatheringstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onnegotiationneeded: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onsignalingstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        ontrack: ((this: RTCPeerConnection, ev: RTCTrackEvent) => any) | null;

        // Required properties
        canTrickleIceCandidates: boolean | null;
        connectionState: RTCPeerConnectionState;
        currentLocalDescription: RTCSessionDescription | null;
        currentRemoteDescription: RTCSessionDescription | null;
        iceConnectionState: RTCIceConnectionState;
        iceGatheringState: RTCIceGatheringState;
        localDescription: RTCSessionDescription | null;
        pendingLocalDescription: RTCSessionDescription | null;
        pendingRemoteDescription: RTCSessionDescription | null;
        remoteDescription: RTCSessionDescription | null;
        sctp: RTCSctpTransport | null;
        signalingState: RTCSignalingState;
        
        // Required methods
        addIceCandidate(candidate: RTCIceCandidateInit | RTCIceCandidate): Promise<void>;
        getConfiguration(): RTCConfiguration;
        getReceivers(): RTCRtpReceiver[];
        getSenders(): RTCRtpSender[];
        getStats(): Promise<RTCStatsReport>;
        getTransceivers(): RTCRtpTransceiver[];
        removeTrack(sender: RTCRtpSender): void;
        restartIce(): void;
        setConfiguration(configuration: RTCConfiguration): void;
    }

    const nonstandard: {
        RTCAudioSource: typeof RTCAudioSource;
        RTCAudioSink: typeof RTCAudioSink;
    };

    // Main module exports
    const wrtc: {
        RTCPeerConnection: typeof RTCPeerConnection;
        MediaStream: typeof MediaStream;
        nonstandard: typeof nonstandard;
    };

    export = wrtc;
}
