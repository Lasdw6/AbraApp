export interface AgentDescriptor {
  id: string;
  peer_id: string;
  capsule_id: string;
  name: string;
  platform: string;
  version?: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
}

export interface BrowserTab {
  url: string;
  title: string;
  scroll?: { x: number; y: number; historyLength: number };
  media?: { currentTime: number; paused: boolean; playbackRate: number; volume: number; muted: boolean } | null;
}
