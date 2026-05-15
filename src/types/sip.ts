export type CallStatus = 'idle' | 'incoming' | 'ringing' | 'answered';
export type CallDirection = 'inbound' | 'outbound' | null;

export interface PhoneState {
  registered: boolean;
  registering: boolean;
  error: string | null;
  callStatus: CallStatus;
  callDirection: CallDirection;
  remoteIdentity: string | null;
  muted: boolean;
}

export interface CallLogEntry {
  id: string;
  direction: 'inbound' | 'outbound';
  remoteIdentity: string;
  startTime: Date;
  endTime: Date | null;
  duration: number | null;
  status: 'answered' | 'missed' | 'failed';
}

export interface Contact {
  name: string;
  extension: string;
}
