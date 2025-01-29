declare module 'wrtc' {
    export interface RTCAudioData {
        samples: Float32Array;
        sampleRate: number;
        channels?: number;
        timestamp?: number;
    }

    export class RTCAudioSource {
        createTrack(): MediaStreamTrack;
        onData(data: RTCAudioData): void;
    }

    export class RTCAudioSink {
        constructor(track: MediaStreamTrack);
        ondata: (frame: RTCAudioData) => void;
        stop(): void;
    }

    export class RTCPeerConnection implements RTCPeerConnectionType {
        constructor(configuration?: RTCConfiguration);
        createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
        setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
        addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver;
        createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
        close(): void;
        
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
        
        onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        ondatachannel: ((this: RTCPeerConnection, ev: RTCDataChannelEvent) => any) | null;
        onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => any) | null;
        oniceconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onicegatheringstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onnegotiationneeded: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onsignalingstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        ontrack: ((this: RTCPeerConnection, ev: RTCTrackEvent) => any) | null;
    }

    export interface MediaStreamTrackInit {
        kind: string;
        id?: string;
    }

    export class MediaStreamTrack implements MediaStreamTrackType {
        constructor(init: MediaStreamTrackInit);
        readonly enabled: boolean;
        readonly id: string;
        readonly kind: string;
        readonly label: string;
        readonly muted: boolean;
        readonly readyState: MediaStreamTrackState;
        readonly remote: boolean;
        onended: ((this: MediaStreamTrack, ev: Event) => any) | null;
        onmute: ((this: MediaStreamTrack, ev: Event) => any) | null;
        onunmute: ((this: MediaStreamTrack, ev: Event) => any) | null;
        clone(): MediaStreamTrack;
        stop(): void;
    }

    export class MediaStream implements MediaStreamType {
        constructor(tracks?: MediaStreamTrack[]);
        readonly active: boolean;
        readonly id: string;
        addTrack(track: MediaStreamTrack): void;
        clone(): MediaStream;
        getAudioTracks(): MediaStreamTrack[];
        getTrackById(trackId: string): MediaStreamTrack | null;
        getTracks(): MediaStreamTrack[];
        getVideoTracks(): MediaStreamTrack[];
        removeTrack(track: MediaStreamTrack): void;
    }

    const nonstandard: {
        RTCAudioSource: typeof RTCAudioSource;
    };

    const wrtc: {
        RTCPeerConnection: typeof RTCPeerConnection;
        MediaStream: typeof MediaStream;
        MediaStreamTrack: typeof MediaStreamTrack;
        RTCAudioSink: typeof RTCAudioSink;
        nonstandard: typeof nonstandard;
    };

    export default wrtc;
}
