
export enum AppStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface TranscriptionEntry {
  type: 'user' | 'agent';
  text: string;
  timestamp: Date;
}

export interface HospitalConfig {
  name: string;
  hours: string;
  departments: string[];
}
