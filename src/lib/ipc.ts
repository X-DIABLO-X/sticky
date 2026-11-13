/**
 * Type-safe IPC client bridging React to Tauri v2 Rust backend
 * Features seamless fallback mock-mode for in-browser development & testing.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig, HardwareProfile, Agent, CronJob, Memory, LocalModelDownload, McpServerConfig, OllamaStatus } from "../types/models";
import type { ToolConfirmationPayload } from "../types/tools";

export function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

// In-browser mock event bus
class BrowserEventBus {
  private listeners: Map<string, Set<(payload: any) => void>> = new Map();

  listen<T>(event: string, handler: (payload: T) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  emit<T>(event: string, payload: T): void {
    const set = this.listeners.get(event);
    if (set) {
      set.forEach((fn) => {
        try {
          fn(payload);
        } catch (e) {
          console.error(`Error in mock event handler for [${event}]:`, e);
        }
      });
    }
  }
}

const mockBus = new BrowserEventBus();

// Default Mock State
const mockConfig: AppConfig = {
  mode: "hybrid",
  hotkeys: {
    talk: "Ctrl+Space",
    dictation: "Ctrl+Shift+D",
    pill: "Ctrl+Alt+C",
    quickInput: "Double-Ctrl",
    abortDrive: "Escape",
  },
  apiKeys: {
    groq: "gsk_mock_key_abc123",
    gemini: "",
    openrouter: "",
  },
  activeAgentId: "clicky-code",
  soundEnabled: true,
  autoAdvanceWalkthrough: true,
  selectedLocalModel: "bonsai-2:9b",
  mcpServers: [
    {
      id: "mcp-fs",
      name: "Local Filesystem MCP",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "D:\\cliky"],
      status: "connected",
      toolsCount: 6,
    },
    {
      id: "mcp-browser",
      name: "Puppeteer Automation MCP",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-puppeteer"],
      status: "connected",
      toolsCount: 12,
    },
  ],
};

const mockHardware: HardwareProfile = {
  gpuName: "NVIDIA GeForce RTX 4070 (12GB VRAM)",
  vramGb: 12,
  totalRamGb: 32,
  cpuCores: 16,
  detectedTier: "tier3_high",
};

const mockAgents: Agent[] = [
  {
    id: "clicky-code",
    name: "Coding Clicky",
    avatar: "⚡",
    role: "Fullstack Architecture & Code Automation",
    systemPrompt: "You are an elite autonomous coding agent with full local terminal and desktop access.",
    model: "bonsai-2:9b",
    status: "idle",
    memoryCount: 18,
    workspacePath: "D:\\cliky",
  },
  {
    id: "clicky-research",
    name: "Research Clicky",
    avatar: "🔍",
    role: "Deep Web Research & Synthesis",
    systemPrompt: "Synthesize complex documentation and inspect online resources.",
    model: "bonsai-2:9b",
    status: "idle",
    memoryCount: 7,
    workspacePath: "D:\\cliky\\docs",
  },
  {
    id: "clicky-routine",
    name: "Automator Clicky",
    avatar: "⏱️",
    role: "Cron Background Automations",
    systemPrompt: "Execute scheduled summaries and system cleanups quietly.",
    model: "bonsai-2:9b",
    status: "scheduled",
    memoryCount: 4,
    workspacePath: "D:\\cliky",
  },
];

const mockCronJobs: CronJob[] = [
  {
    id: "cron-morning",
    agentId: "clicky-routine",
    schedule: "0 9 * * 1-5",
    naturalSchedule: "Every weekday at 9:00 AM",
    prompt: "Scan Git commits and unread emails; generate morning standup summary.",
    lastRun: "Yesterday at 9:00 AM",
    nextRun: "Tomorrow at 9:00 AM",
    enabled: true,
  },
  {
    id: "cron-cleanup",
    agentId: "clicky-routine",
    schedule: "0 18 * * 5",
    naturalSchedule: "Every Friday at 6:00 PM",
    prompt: "Clean up dangling node_modules and temporary screen captures.",
    lastRun: "Last Friday",
    nextRun: "Friday at 6:00 PM",
    enabled: false,
  },
];

const mockMemories: Memory[] = [
  {
    id: "mem-1",
    scope: "preference",
    key: "preferred_ide",
    value: "VS Code with Vim keybindings and dark high-contrast theme",
    updatedAt: "2 days ago",
  },
  {
    id: "mem-2",
    scope: "project",
    key: "active_stack",
    value: "Tauri v2 + React 19 + TypeScript + TailwindCSS + Kokoro TTS",
    updatedAt: "Today, 10:14 AM",
  },
  {
    id: "mem-3",
    scope: "fact",
    key: "work_directory",
    value: "D:\\cliky",
    updatedAt: "3 days ago",
  },
];

const mockLocalModels: LocalModelDownload[] = [
  {
    id: "silero-vad",
    name: "Silero VAD v5 (ONNX)",
    filename: "silero_vad.onnx",
    sizeMb: 5,
    downloadedMb: 5,
    status: "ready",
    description: "Ultra-fast voice activity detector with 30ms streaming inference.",
  },
  {
    id: "moonshine-tiny",
    name: "Moonshine Streaming STT",
    filename: "moonshine_tiny_int8.onnx",
    sizeMb: 110,
    downloadedMb: 110,
    status: "ready",
    description: "Sub-100ms streaming speech-to-text with conversational turn detection.",
  },
  {
    id: "kokoro-82m",
    name: "Kokoro-82M TTS (ONNX)",
    filename: "kokoro_v1.0_82m.onnx",
    sizeMb: 160,
    downloadedMb: 160,
    status: "ready",
    description: "Expressive multi-speaker text-to-speech with 15ms first-packet latency.",
  },
  {
    id: "bonsai-2-9b",
    name: "Bonsai-2 9B (Ollama Local)",
    filename: "bonsai-2:9b",
    sizeMb: 5200,
    downloadedMb: 5200,
    status: "ready",
    description: "State-of-the-art local multimodal model with spatial tagging and UI element automation.",
  },
];

/**
 * Invoke a Rust backend command safely with automatic browser fallbacks
 */
export async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    try {
      return await invoke<T>(command, args);
    } catch (err) {
      console.error(`Tauri command failed: [${command}]`, err);
      throw err;
    }
  }

  // Fallback mock responses for browser development
  console.log(`[IPC Mock Invoke] ${command}`, args);
  await new Promise((res) => setTimeout(res, 60)); // Simulate brief IPC hop

  switch (command) {
    case "get_config":
      return { ...mockConfig } as unknown as T;
    case "save_config":
      if (args?.config) Object.assign(mockConfig, args.config);
      return { success: true } as unknown as T;
    case "get_hardware_profile":
      return { ...mockHardware } as unknown as T;
    case "get_agents":
      return [...mockAgents] as unknown as T;
    case "get_cron_jobs":
      return [...mockCronJobs] as unknown as T;
    case "get_memories":
      return [...mockMemories] as unknown as T;
    case "get_local_models":
      return [...mockLocalModels] as unknown as T;
    case "overlay_set_ignore_cursor":
      return undefined as unknown as T;
    case "confirm_tool_call":
    case "reject_tool_call":
      return { ok: true } as unknown as T;
    case "toggle_talk":
    case "toggle_dictation":
      return { active: true } as unknown as T;
    case "mcp_test_connection":
      return { ok: true, toolsCount: 8 } as unknown as T;
    case "get_ollama_models":
      return ["bonsai-2:9b"] as unknown as T;
    case "check_ollama_status":
      return {
        running: true,
        url: "http://127.0.0.1:11434",
        models: ["bonsai-2:9b"],
        current_model: "bonsai-2:9b"
      } as unknown as T;
    case "set_active_model":
      return { ok: true } as unknown as T;
    case "execute_prompt":
      return "Hello! I am your HeyClicky AI companion powered by Ollama." as unknown as T;
    default:
      return {} as unknown as T;
  }
}

export async function executePrompt(prompt: string, agentId?: string): Promise<string> {
  return invokeCommand<string>("execute_prompt", { prompt, agentId });
}

export async function getOllamaModels(): Promise<string[]> {
  return invokeCommand<string[]>("get_ollama_models");
}

export async function checkOllamaStatus(): Promise<OllamaStatus> {
  return invokeCommand<OllamaStatus>("check_ollama_status");
}

export async function setActiveModel(modelName: string): Promise<void> {
  return invokeCommand<void>("set_active_model", { modelName });
}

/**
 * Listen for events emitted by the Rust core or mock bus
 */
export async function listenEvent<T>(eventName: string, handler: (payload: T) => void): Promise<() => void> {
  if (isTauri()) {
    const unlisten: UnlistenFn = await listen<T>(eventName, (event) => {
      handler(event.payload);
    });
    return unlisten;
  }

  return mockBus.listen(eventName, handler);
}

/**
 * Emit an event across windows or to Rust core
 */
export async function emitEvent<T>(eventName: string, payload: T): Promise<void> {
  if (isTauri()) {
    await emit(eventName, payload);
    return;
  }

  mockBus.emit(eventName, payload);
}

/**
 * Dynamic click-through hit-testing controller
 */
export async function setIgnoreCursorEvents(ignore: boolean): Promise<void> {
  if (isTauri()) {
    try {
      const win = getCurrentWindow();
      await win.setIgnoreCursorEvents(ignore);
    } catch (err) {
      console.warn("setIgnoreCursorEvents failed:", err);
    }
  } else {
    // In browser, toggle pointer-events on the overlay body
    const root = document.getElementById("root");
    if (root) {
      root.style.pointerEvents = ignore ? "none" : "auto";
    }
  }
}

/**
 * Helper to manually dispatch mock events in dev/testing mode
 */
export function dispatchMockEvent<T>(eventName: string, payload: T): void {
  mockBus.emit(eventName, payload);
}
