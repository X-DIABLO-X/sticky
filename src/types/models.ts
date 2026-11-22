/**
 * Domain models for configuration, hardware detection, agents, cron schedules, and persistent memory
 */

export type ModelTier = 'tier1_low' | 'tier2_mid' | 'tier3_high' | 'cloud_free';

export interface HardwareProfile {
  gpuName?: string;
  vramGb?: number;
  totalRamGb: number;
  cpuCores: number;
  detectedTier: ModelTier;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  toolsCount?: number;
}

export interface AppHotkeys {
  talk: string;
  dictation: string;
  pill: string;
  quickInput: string;
  abortDrive: string;
}

export interface AppApiKeys {
  groq?: string;
  gemini?: string;
  openrouter?: string;
}

export interface OllamaStatus {
  running: boolean;
  url: string;
  models: string[];
  current_model: string;
}

export interface CodexAuthStatus {
  authenticated: boolean;
  email?: string | null;
  account_id?: string | null;
  expires_at?: number | null;
  auth_path: string;
  model: string;
  codex_only: boolean;
}

export interface AppConfig {
  mode: 'local' | 'hybrid' | 'cloud';
  hotkeys: AppHotkeys;
  apiKeys: AppApiKeys;
  activeAgentId: string;
  soundEnabled: boolean;
  autoAdvanceWalkthrough: boolean;
  mcpServers: McpServerConfig[];
  selectedLocalModel: string;
  local_llama_url?: string;
  local_model_name?: string;
  codex_model_name?: string;
  use_chatgpt_codex_only?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  avatar: string;
  role: string;
  systemPrompt?: string;
  model: string;
  status: 'idle' | 'busy' | 'scheduled';
  memoryCount?: number;
  workspacePath?: string;
}

export interface CronJob {
  id: string;
  agentId: string;
  schedule: string;
  naturalSchedule: string;
  prompt: string;
  lastRun?: string;
  nextRun?: string;
  enabled: boolean;
}

export type MemoryScope = 'preference' | 'project' | 'fact';

export interface Memory {
  id: string;
  scope: MemoryScope;
  key: string;
  value: string;
  updatedAt: string;
}

export interface LocalModelDownload {
  id: string;
  name: string;
  filename: string;
  sizeMb: number;
  downloadedMb: number;
  status: 'not_downloaded' | 'downloading' | 'ready' | 'error';
  description: string;
}
