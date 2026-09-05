export {};

declare global {
  interface Window {
    abra?: {
      providerConfig(): Promise<ProviderConfig | null>;
      agentTicket(): Promise<{ command: string; expires_in_seconds: number; installs_cli: boolean }>;
      exportInstaller(): Promise<string | null>;
      agentList(): Promise<ProviderConfig[]>;
      agentSelect(id: string): Promise<ProviderConfig>;
      sandbox(action: string, payload?: Record<string, unknown>): Promise<any>;
      local(args: string[]): Promise<string>;
      remote(args: string[]): Promise<string>;
      config(): Promise<Endpoint>;
      chooseWorkspace(): Promise<string | null>;
      appTarget(name: string, sessionId: string): Promise<string>;
      appStart(workspace: string): Promise<{ active: boolean; url: string; port: number; workspace: string; command: string[]; output: string }>;
      appStop(): Promise<{ active: boolean }>;
      appStatus(): Promise<{ active: boolean; url: string | null; port?: number; workspace?: string; command?: string[]; output?: string }>;
      appOpen(): Promise<{ active: boolean; url: string; port: number; workspace: string; command: string[]; output: string }>;
      egressStart(): Promise<{ active: boolean; proxyUrl: string }>;
      egressStop(): Promise<{ active: boolean }>;
      egressStatus(): Promise<{ active: boolean; proxyUrl: string | null }>;
      novncStart(): Promise<{ active: boolean; url: string }>;
      novncStop(): Promise<{ active: boolean; url: null }>;
      novncStatus(): Promise<{ active: boolean; url: string | null }>;
      novncOpen(): Promise<{ active: boolean; url: string }>;
    };
  }

  interface Endpoint {
    abra_peer_id: string;
    local_peer_id: string;
  }
  interface ProviderConfig {
    id: string;
    peer_id: string;
    capsule_id: string;
    name: string;
    platform: string;
  }
}
