export interface AgentDescriptor {
  id: string;
  peer_id: string;
  capsule_id: string;
  name: string;
  platform: string;
}

export interface RuntimePaths {
  node: string;
  wrapper: string;
  abra: string;
  adapter: string;
  observer: string;
  asNode: boolean;
}

export interface AppRecipe { argv: string[]; cwd: string; ports: number[]; env?: Record<string, string> }
export interface RunningApp { active: true; url: string; port: number; workspace: string; command: string[]; output: string }
export type LocalAppStatus = RunningApp | { active: false; url: null };
export interface SessionDetails {
  session_id: string;
  cwd: string;
  updated_at: string;
  bytes: number;
  user_turns: number;
  assistant_messages: number;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface SandboxResponses {
  status: { active: {
    browser?: { url: string; title: string; cookie_count: number; include_storage: boolean };
    codex?: { session: string; workspace: string };
  } };
  'browser-frame': { title: string; url: string; image: string; githubSignedIn?: boolean | null; vercelSignedIn?: boolean | null };
  'browser-up': { transferred: boolean; cookie_count: number; omitted_cookie_count: number };
  'browser-down': { returned: boolean };
  'browser-input': unknown;
  'browser-revoke': unknown;
  'codex-up': SessionDetails;
  'codex-inspect': SessionDetails;
  'codex-run': SessionDetails;
  'codex-down': { workspace: string; details: SessionDetails };
  'app-inspect': { workspace: string; recipes: AppRecipe[]; selected: AppRecipe | null };
}

export interface TeleportBridge {
  providerConfig(): Promise<AgentDescriptor | null>;
  agentTicket(): Promise<{ command: string; expires_in_seconds: number; installs_cli: boolean }>;
  exportInstaller(): Promise<string | null>;
  agentList(): Promise<AgentDescriptor[]>;
  agentSelect(id: string): Promise<AgentDescriptor>;
  sandbox<K extends keyof SandboxResponses>(action: K, payload?: Record<string, unknown>): Promise<SandboxResponses[K]>;
  local(args: string[]): Promise<string>;
  chooseWorkspace(): Promise<string | null>;
  appTarget(name: string, sessionId: string): Promise<string>;
  appStart(workspace: string): Promise<RunningApp>;
  appStop(): Promise<{ active: false }>;
  appStatus(): Promise<LocalAppStatus>;
  appOpen(): Promise<RunningApp>;
}
