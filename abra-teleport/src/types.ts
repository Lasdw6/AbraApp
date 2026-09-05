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

export interface SessionRecord {
  session_id: string;
  cwd: string;
  cli_version: string;
  updated_at: string;
  bytes: number;
  file: string;
}

export interface SecretFinding { category: string; line: number }
export interface WorkspaceFinding { category: string; path: string; line?: number }
export interface BrowserTab {
  url: string;
  title: string;
  scroll?: { x: number; y: number; historyLength: number };
  media?: { currentTime: number; paused: boolean; playbackRate: number; volume: number; muted: boolean } | null;
}

export interface Recipe {
  argv: string[];
  cwd: string;
  ports: number[];
  env?: Record<string, string>;
}
