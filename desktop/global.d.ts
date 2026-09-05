import type { AgentDescriptor, TeleportBridge } from './shared/contracts';

declare global {
  interface Window { abra?: TeleportBridge }
  type ProviderConfig = AgentDescriptor;
}
