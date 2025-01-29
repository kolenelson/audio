// WebRTC standard types
interface RTCSessionDescriptionInit {
    type: RTCSdpType;
    sdp: string;
}
type RTCSdpType = 'offer' | 'answer' | 'pranswer' | 'rollback';

interface RTCDataChannel extends EventTarget {
    readonly label: string;
    readonly ordered: boolean;
    readonly maxPacketLifeTime: number | null;
    readonly maxRetransmits: number | null;
    readonly protocol: string;
    readonly negotiated: boolean;
    readonly id: number | null;
    readonly readyState: RTCDataChannelState;
    readonly bufferedAmount: number;
    readonly bufferedAmountLowThreshold: number;
    close(): void;
    send(data: string | Blob | ArrayBuffer | ArrayBufferView): void;
    onopen: ((this: RTCDataChannel, ev: Event) => any) | null;
    onmessage: ((this: RTCDataChannel, ev: MessageEvent) => any) | null;
    onclose: ((this: RTCDataChannel, ev: Event) => any) | null;
    onerror: ((this: RTCDataChannel, ev: Event) => any) | null;
}

interface RTCRtpTransceiver {
    readonly mid: string | null;
    readonly sender: RTCRtpSender;
    readonly receiver: RTCRtpReceiver;
    readonly stopped: boolean;
    readonly direction: RTCRtpTransceiverDirection;
    setDirection(direction: RTCRtpTransceiverDirection): Promise<void>;
    stop(): void;
}

interface RTCRtpSender {
    readonly track: MediaStreamTrack | null;
    readonly transport: RTCDtlsTransport | null;
    readonly rtcpTransport: RTCDtlsTransport | null;
}

interface RTCRtpReceiver {
    readonly track: MediaStreamTrack;
    readonly transport: RTCDtlsTransport | null;
    readonly rtcpTransport: RTCDtlsTransport | null;
}

interface RTCDtlsTransport extends EventTarget {
    readonly state: RTCDtlsTransportState;
    readonly iceTransport: RTCIceTransport;
}

type RTCDtlsTransportState = 'new' | 'connecting' | 'connected' | 'closed' | 'failed';
type RTCDataChannelState = 'connecting' | 'open' | 'closing' | 'closed';
type RTCRtpTransceiverDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

interface RTCIceTransport extends EventTarget {
    readonly state: RTCIceTransportState;
    readonly gatheringState: RTCIceGatheringState;
    getSelectedCandidatePair(): RTCIceCandidatePair | null;
}

type RTCIceTransportState = 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed';
type RTCIceGatheringState = 'new' | 'gathering' | 'complete';

interface RTCIceCandidatePair {
    local: RTCIceCandidate;
    remote: RTCIceCandidate;
}

declare module 'wrtc' {
    import { EventEmitter } from 'events';

    export interface RTCAudioData {
        samples: Float32Array;
        sampleRate: number;
        channels?: number;
        timestamp?: number;
    }

    export class RTCAudioSource {
        constructor();
        createTrack(): MediaStreamTrack;
        onData(data: RTCAudioData): void;
    }

    export class RTCAudioSink {
        constructor(track: MediaStreamTrack);
        ondata: (frame: RTCAudioData) => void;
        stop(): void;
    }

    export class RTCPeerConnection extends EventEmitter {
        constructor(configuration?: RTCConfiguration);
        createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
        setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
        addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver;
        createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
        close(): void;
        
        // Event handlers
        onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
        oniceconnectionstatechange: (() => void) | null;
        onicegatheringstatechange: (() => void) | null;
        onnegotiationneeded: (() => void) | null;
        ondatachannel: ((event: RTCDataChannelEvent) => void) | null;
        
        // Properties
        readonly localDescription: RTCSessionDescription | null;
        readonly remoteDescription: RTCSessionDescription | null;
        readonly iceConnectionState: RTCIceConnectionState;
        readonly iceGatheringState: RTCIceGatheringState;
        readonly signalingState: RTCSignalingState;
    }

    export class MediaStream extends EventEmitter {
        constructor(tracks?: MediaStreamTrack[]);
        addTrack(track: MediaStreamTrack): void;
        removeTrack(track: MediaStreamTrack): void;
        getTracks(): MediaStreamTrack[];
        getVideoTracks(): MediaStreamTrack[];
        getAudioTracks(): MediaStreamTrack[];
    }

    export const nonstandard: {
        RTCAudioSource: typeof RTCAudioSource;
    };
}
