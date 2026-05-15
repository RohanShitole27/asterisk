declare module 'jssip' {
  export class WebSocketInterface {
    constructor(url: string);
  }

  export interface UAConfiguration {
    sockets: WebSocketInterface[];
    uri: string;
    password: string;
    register?: boolean;
    register_expires?: number;
    user_agent?: string;
    session_timers?: boolean;
  }

  export interface CallOptions {
    mediaConstraints?: { audio: boolean; video: boolean };
    rtcOfferConstraints?: { offerToReceiveAudio: boolean; offerToReceiveVideo: boolean };
    pcConfig?: RTCConfiguration;
  }

  export interface AnswerOptions {
    mediaConstraints?: { audio: boolean; video: boolean };
  }

  export interface MuteOptions {
    audio?: boolean;
    video?: boolean;
  }

  export interface MuteStatus {
    audio: boolean;
    video: boolean;
  }

  export class RTCSession {
    connection: RTCPeerConnection;
    direction: 'incoming' | 'outgoing';
    remote_identity: { uri: { user: string; toString(): string } };
    answer(options?: AnswerOptions): void;
    terminate(): void;
    mute(options?: MuteOptions): void;
    unmute(options?: MuteOptions): void;
    isMuted(): MuteStatus;
    isEnded(): boolean;
    isEstablished(): boolean;
    sendDTMF(tone: string): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }

  export class UA {
    constructor(config: UAConfiguration);
    start(): void;
    stop(): void;
    register(): void;
    unregister(options?: { all?: boolean }): void;
    call(target: string, options: CallOptions): RTCSession;
    on(event: string, listener: (...args: unknown[]) => void): void;
    isRegistered(): boolean;
  }

  export const debug: {
    enable(namespaces: string): void;
    disable(): void;
  };
}
