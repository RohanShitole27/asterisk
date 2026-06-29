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
  ivrOption?: string | null;
  ivrCompleted?: boolean;
  recordingSid?: string | null;      // Twilio PSTN recording
  sipRecordingFile?: string | null;  // Asterisk SIP recording filename
  extension?: string | null;         // which extension/agent handled this call
}

export interface IvrEvent {
  id: string;
  call_sid: string;
  event_type: string;
  selected_option: string | null;
  created_at: string;
}

export interface Contact {
  id: number;
  name: string;
  extension: string;
}

export interface ExtensionDirectoryEntry {
  extension: string;
  assignedTo: string | null;
}

export type UserRole = 'admin' | 'manager' | 'agent';

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  extension: string | null;
  isActive: boolean;
  managerId: number | null;
}
