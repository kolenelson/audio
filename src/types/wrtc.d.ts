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

    // Define WrtcPeerConnection instead of RTCPeerConnection
    class WrtcPeerConnection implements EventTarget {
        constructor(configuration?: RTCConfiguration);
        
        // EventTarget methods
        addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
        dispatchEvent(event: Event): boolean;

        // RTCPeerConnection methods
        addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
        createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
        createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
        setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
        addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver;
        createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
        close(): void;
        
        // Event handlers
        onconnectionstatechange: ((this: WrtcPeerConnection, ev: Event) => any) | null;
        ondatachannel: ((this: WrtcPeerConnection, ev: RTCDataChannelEvent) => any) | null;
        onicecandidate: ((this: WrtcPeerConnection, ev: RTCPeerConnectionIceEvent) => any) | null;
        onicecandidateerror: ((this: WrtcPeerConnection, ev: Event) => any) | null;
        oniceconnectionstatechange: ((this: WrtcPeerConnection, ev: Event) => any) | null;
        onicegatheringstatechange: ((this: WrtcPeerConnection, ev: Event) => any) | null;
        onnegotiationneeded: ((this: WrtcPeerConnection, ev: Event) => any) | null;
        onsignalingstatechange: ((this: WrtcPeerConnection, ev: Event) => any) | null;
        ontrack: ((this: WrtcPeerConnection, ev: RTCTrackEvent) => any) | null;

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
        RTCPeerConnection: typeof WrtcPeerConnection;
        MediaStream: typeof MediaStream;
        nonstandard: typeof nonstandard;
    };

    export = wrtc;
}
