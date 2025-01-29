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
