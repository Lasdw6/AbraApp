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

export interface ConnectionHealth {
  agent_id: string | null;
  status: 'connected' | 'unreachable' | 'unpaired';
  last_seen: string | null;
  checked_at: string;
  error: string | null;
}

export interface BrowserSession { id?: string; url: string; title: string; cookie_count: number; include_storage: boolean }

export interface SandboxResponses {
  status: { active: {
    browser?: BrowserSession;
    browsers?: BrowserSession[];
  } };
  'browser-frame': { title: string; url: string; image: string; githubSignedIn?: boolean | null; vercelSignedIn?: boolean | null };
  'browser-up': { transferred: boolean; cookie_count: number; omitted_cookie_count: number; session: BrowserSession };
  'browser-tabs': { tabs: Array<{ id: string; title: string; url: string; host: string }> };
  'browser-incoming': { incoming: Array<{ id: string; received_at: string }> };
  'browser-accept': { returned: boolean };
  'browser-pull': { returned: boolean };
  'browser-down': { returned: boolean };
  'browser-input': unknown;
  'browser-revoke': { revoked: boolean | string; already_revoked?: boolean; cleanup_warning?: string };

}

export interface TeleportBridge {
  providerConfig(): Promise<AgentDescriptor | null>;
  agentTicket(): Promise<{ command: string; expires_in_seconds: number; installs_cli: boolean }>;
  exportInstaller(): Promise<string | null>;
  connectionHealth(): Promise<ConnectionHealth>;
  agentList(): Promise<AgentDescriptor[]>;
  agentSelect(id: string): Promise<AgentDescriptor>;
  sandbox<K extends keyof SandboxResponses>(action: K, payload?: Record<string, unknown>): Promise<SandboxResponses[K]>;
  local(args: string[]): Promise<string>;

}
