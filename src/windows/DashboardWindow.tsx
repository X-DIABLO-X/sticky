import React, { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Toaster, toast } from "sonner";
import {
  Activity,
  Bot,
  Clock,
  Cpu,
  Database,
  Mic,
  RefreshCw,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { getCodexAuthStatus, invokeCommand, listenEvent } from "../lib/ipc";
import {
  Badge,
  Button,
  Card,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TooltipProvider,
} from "../components/ui/primitives";
import { AgentList } from "../components/agents/AgentList";
import { CronManager } from "../components/agents/CronManager";
import { AudioSettings } from "../components/settings/AudioSettings";
import { ModelSettings } from "../components/settings/ModelSettings";
import { HotkeySettings } from "../components/settings/HotkeySettings";
import { McpSettings } from "../components/settings/McpSettings";
import { LiveLogs } from "../components/dashboard/LiveLogs";
import type {
  AppConfig,
  CodexAuthStatus,
  HardwareProfile as DomainHardwareProfile,
  LocalModelDownload,
  McpServerConfig,
  AppHotkeys,
} from "../types/models";

interface OllamaStatus {
  running: boolean;
  models: string[];
}

interface HardwareProfile {
  os: string;
  arch: string;
  cpu_cores: number;
  has_nvidia_gpu: boolean;
  recommended_tier: string;
}

interface MemoryEntry {
  id: string;
  content: string;
  scope?: string;
}

const defaultAppConfig: AppConfig = {
  mode: "hybrid",
  hotkeys: {
    talk: "Ctrl+Space",
    dictation: "Alt+Shift+D",
    pill: "Ctrl+Alt+A",
    quickInput: "Ctrl+Alt+Q",
    abortDrive: "Escape",
  },
  apiKeys: {
    groq: "",
    gemini: "",
    openrouter: "",
  },
  activeAgentId: "default",
  soundEnabled: true,
  autoAdvanceWalkthrough: true,
  mcpServers: [],
  selectedLocalModel: "bonsai-2:9b",
  codex_model_name: "gpt-6-luna",
  use_chatgpt_codex_only: true,
};

const defaultHardware: DomainHardwareProfile = {
  gpuName: "Auto GPU / NPU",
  vramGb: 8,
  totalRamGb: 16,
  cpuCores: 8,
  detectedTier: "tier2_mid",
};

const defaultLocalModels: LocalModelDownload[] = [
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

export const DashboardWindow: React.FC = () => {
  const [ollama, setOllama] = useState<OllamaStatus>({ running: false, models: [] });
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus>({
    authenticated: false,
    email: null,
    account_id: null,
    expires_at: null,
    auth_path: "",
    model: "gpt-6-luna",
    codex_only: true,
  });
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [hardwareProfile, setHardwareProfile] = useState<DomainHardwareProfile>(defaultHardware);
  const [config, setConfig] = useState<AppConfig>(defaultAppConfig);
  const [localModels, setLocalModels] = useState<LocalModelDownload[]>(defaultLocalModels);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingLlm, setTestingLlm] = useState(false);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ollamaRes, codexRes, hwRes, memRes, cfgRes, modelsRes, mcpRes] = await Promise.allSettled([
        invokeCommand<OllamaStatus>("check_ollama_status"),
        getCodexAuthStatus(),
        invokeCommand<any>("get_hardware_profile"),
        invokeCommand<MemoryEntry[]>("get_memories"),
        invokeCommand<any>("get_config"),
        invokeCommand<LocalModelDownload[]>("get_local_models"),
        invokeCommand<any[]>("get_mcp_servers"),
      ]);
      if (ollamaRes.status === "fulfilled") setOllama(ollamaRes.value);
      if (codexRes.status === "fulfilled" && codexRes.value) {
        setCodexAuth({
          ...codexRes.value,
          model: codexRes.value.model?.trim() || "gpt-6-luna",
        });
      }
      if (hwRes.status === "fulfilled" && hwRes.value) {
        setHardware(hwRes.value);
        setHardwareProfile({
          gpuName: hwRes.value.has_nvidia_gpu ? "NVIDIA GeForce GPU" : "Integrated / CPU Acceleration",
          vramGb: hwRes.value.has_nvidia_gpu ? 8 : 0,
          totalRamGb: hwRes.value.total_ram_gb || 16,
          cpuCores: hwRes.value.cpu_cores || 8,
          detectedTier: (hwRes.value.recommended_tier as any) || "tier2_mid",
        });
      }
      if (memRes.status === "fulfilled") setMemories(memRes.value);
      if (cfgRes.status === "fulfilled" && cfgRes.value) {
        const c = cfgRes.value;
        setConfig((prev) => ({
          ...prev,
          apiKeys: {
            groq: c.groq_api_key || "",
            gemini: c.gemini_api_key || "",
            openrouter: c.openrouter_api_key || "",
          },
          selectedLocalModel: c.local_model_name || prev.selectedLocalModel,
          local_llama_url: c.local_llama_url || prev.local_llama_url,
          codex_model_name: c.codex_model_name ?? prev.codex_model_name,
          use_chatgpt_codex_only: c.use_chatgpt_codex_only ?? prev.use_chatgpt_codex_only,
          hotkeys: {
            talk: c.hotkeys?.talk || prev.hotkeys.talk,
            dictation: c.hotkeys?.dictation || prev.hotkeys.dictation,
            pill: c.hotkeys?.pill || prev.hotkeys.pill,
            quickInput: c.hotkeys?.quick_input || prev.hotkeys.quickInput,
            abortDrive: prev.hotkeys.abortDrive,
          },
        }));
      }
      if (modelsRes.status === "fulfilled" && modelsRes.value?.length) {
        setLocalModels(modelsRes.value);
      }
      if (mcpRes.status === "fulfilled" && mcpRes.value) {
        setMcpServers(
          mcpRes.value.map((s: any) => ({
            id: s.id,
            name: s.name,
            transport: (s.transport as any) || "stdio",
            command: s.command,
            args: s.args,
            status: "connected",
            toolsCount: 5,
          }))
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSaveConfig = async (updated: Partial<AppConfig>) => {
    const next = { ...config, ...updated };
    setConfig(next);
    try {
      const currentRaw: Record<string, unknown> = await invokeCommand<Record<string, unknown>>("get_config").catch(
        () => ({} as Record<string, unknown>)
      );
      const preservedCodexModel =
        updated.codex_model_name ??
        (typeof currentRaw.codex_model_name === "string"
          ? currentRaw.codex_model_name
          : next.codex_model_name ?? "gpt-6-luna");
      const preservedCodexOnly =
        updated.use_chatgpt_codex_only ??
        (typeof currentRaw.use_chatgpt_codex_only === "boolean"
          ? currentRaw.use_chatgpt_codex_only
          : next.use_chatgpt_codex_only ?? true);
      await invokeCommand("save_config", {
        config: {
          ...currentRaw,
          groq_api_key: next.apiKeys?.groq?.trim() || null,
          gemini_api_key: next.apiKeys?.gemini?.trim() || null,
          openrouter_api_key: next.apiKeys?.openrouter?.trim() || null,
          local_llama_url: next.local_llama_url || "http://127.0.0.1:11434",
          local_model_name: next.selectedLocalModel || "bonsai-2:9b",
          codex_model_name: preservedCodexModel,
          use_chatgpt_codex_only: preservedCodexOnly,
          hotkeys: {
            talk: next.hotkeys.talk,
            dictation: next.hotkeys.dictation,
            pill: next.hotkeys.pill,
            quick_input: next.hotkeys.quickInput,
          },
        },
      });
      toast.success("Configuration saved to disk");
    } catch (e) {
      toast.error(`Failed to save configuration: ${e}`);
    }
  };

  const handleSaveHotkeys = async (updated: AppHotkeys) => {
    setConfig((prev) => ({ ...prev, hotkeys: updated }));
    try {
      await invokeCommand("update_hotkeys", {
        hotkeys: {
          talk: updated.talk,
          dictation: updated.dictation,
          pill: updated.pill,
          quick_input: updated.quickInput,
        },
      });
      toast.success("Global shortcuts updated");
    } catch (e) {
      toast.error("Failed to update global shortcuts");
    }
  };

  const handleDownloadModel = async (modelId: string) => {
    try {
      toast.info(`Downloading model ${modelId}...`);
      await invokeCommand("download_local_model", { model_id: modelId });
      toast.success(`Model ${modelId} installed`);
    } catch (e) {
      toast.error(`Model download error: ${e}`);
    }
  };

  const handleAddMcpServer = async (server: McpServerConfig) => {
    setMcpServers((prev) => [...prev, server]);
    try {
      await invokeCommand("save_mcp_server", {
        server: {
          id: server.id,
          name: server.name,
          command: server.command || "npx",
          args: server.args || [],
          enabled: true,
        },
      });
      toast.success(`MCP Server ${server.name} registered`);
    } catch (e) {
      toast.error("Failed to add MCP server");
    }
  };

  const handleRemoveMcpServer = async (serverId: string) => {
    setMcpServers((prev) => prev.filter((s) => s.id !== serverId));
    try {
      await invokeCommand("delete_mcp_server", { id: serverId });
      toast.success("MCP Server removed");
    } catch (e) {
      toast.error("Failed to remove MCP server");
    }
  };

  const handleTestMcp = async (serverId: string): Promise<boolean> => {
    try {
      await invokeCommand("mcp_test_connection", { serverId });
      toast.success("MCP connection verified");
      return true;
    } catch (e) {
      toast.error("MCP connection probe failed");
      return false;
    }
  };

  useEffect(() => {
    refreshAll();
    const unlistenErr = listenEvent<{ stage: string; message: string }>("pipeline:error", (payload) => {
      toast.error(`${payload.stage.toUpperCase()} Pipeline Error`, {
        description: payload.message,
        duration: 6000,
      });
    });
    const unlistenCodex = listenEvent<CodexAuthStatus>("codex:auth_changed", (payload) => {
      if (!payload) return;
      const resolvedModel = payload.model?.trim() || "gpt-6-luna";
      setCodexAuth({ ...payload, model: resolvedModel });
      setConfig((prev) => ({
        ...prev,
        codex_model_name: resolvedModel,
        use_chatgpt_codex_only: payload.codex_only,
      }));
    });
    return () => {
      unlistenErr.then((fn) => fn && fn());
      unlistenCodex.then((fn) => fn && fn());
    };
  }, [refreshAll]);

  const handleTestLlm = async () => {
    setTestingLlm(true);
    try {
      const reply = await invokeCommand<string>("execute_prompt", {
        prompt: "Reply with exactly: Sticky LLM connection OK.",
      });
      toast.success("LLM Pipeline Connected", { description: reply.slice(0, 120) });
    } catch (err) {
      toast.error("LLM Connection Failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingLlm(false);
    }
  };

  const handleTestTalk = async () => {
    try {
      toast.info("Listening via Microphone...", {
        description: "Speak now — Sticky will transcribe, query the LLM, and speak back.",
      });
      await invokeCommand("start_talk");
    } catch (err) {
      toast.error("Failed to start Talk Mode", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleClearMemory = async () => {
    try {
      await invokeCommand("clear_memory");
      setMemories([]);
      toast.success("All stored memories cleared");
    } catch (err) {
      toast.error("Failed to clear memory", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <TooltipProvider>
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
      <Tabs
        defaultValue="overview"
        orientation="vertical"
        className="surface-canvas flex h-screen w-screen overflow-hidden text-sm text-zinc-100 select-none"
      >
        {/* Sidebar */}
        <aside className="w-56 border-r border-white/[0.08] bg-[#0f1115] flex flex-col justify-between p-3">
          <div>
            <div className="flex items-center justify-between px-2.5 py-2 mb-4">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <span className="font-semibold tracking-tight text-zinc-100">Sticky</span>
              </div>
              <Badge tone="neutral">v0.2</Badge>
            </div>

            <TabsList className="flex flex-col space-y-1">
              {[
                { id: "overview", label: "Overview", icon: <Activity className="w-4 h-4" /> },
                { id: "logs", label: "Live Logs", icon: <Terminal className="w-4 h-4" /> },
                { id: "agents", label: "Agents", icon: <Bot className="w-4 h-4" /> },
                { id: "memory", label: "Memory", icon: <Database className="w-4 h-4" /> },
                { id: "cron", label: "Schedules", icon: <Clock className="w-4 h-4" /> },
                { id: "settings", label: "Settings", icon: <Settings className="w-4 h-4" /> },
              ].map((item) => (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/40 data-[state=active]:bg-zinc-800/90 data-[state=active]:text-zinc-100 data-[state=active]:font-medium transition-colors"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <Card className="p-2.5 space-y-1.5 text-xs">
            <div className="flex items-center justify-between text-zinc-400">
              <span>Talk (Hold)</span>
              <span className="kbd-cap">Ctrl+Space</span>
            </div>
            <div className="flex items-center justify-between text-zinc-400">
              <span>Dictate</span>
              <span className="kbd-cap">Ctrl+Shift+D</span>
            </div>
            <div className="flex items-center justify-between text-zinc-400">
              <span>Palette</span>
              <span className="kbd-cap">Ctrl+Alt+Space</span>
            </div>
          </Card>
        </aside>

        {/* Main View */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <header className="h-14 border-b border-white/[0.08] px-6 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-200">Control Center</span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={handleTestLlm} disabled={testingLlm}>
                <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                {testingLlm ? "Testing LLM..." : "Test LLM"}
              </Button>
              <Button variant="primary" size="sm" onClick={handleTestTalk}>
                <Mic className="w-3.5 h-3.5" />
                Test Voice Pipeline
              </Button>
              <Button variant="ghost" size="icon" onClick={refreshAll} disabled={loading}>
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto p-6">
            <TabsContent value="overview" className="space-y-5 outline-none">
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
              >
                <Card className="p-4 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>ChatGPT Codex</span>
                    <Sparkles
                      className={`w-4 h-4 ${
                        codexAuth.authenticated ? "text-emerald-400" : "text-zinc-500"
                      }`}
                    />
                  </div>
                  {codexAuth.authenticated ? (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1.5 text-base font-semibold text-emerald-400">
                          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                          Connected · {codexAuth.model || "gpt-6-luna"}
                        </span>
                      </div>
                      <p
                        className="text-xs text-zinc-500 truncate"
                        title={codexAuth.email || codexAuth.account_id || undefined}
                      >
                        {codexAuth.email || codexAuth.account_id || "ChatGPT OAuth Active"}
                        {codexAuth.codex_only ? " · LLM Only" : ""}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-semibold text-zinc-100">Not Signed In</span>
                        <Badge tone="warning">OAuth</Badge>
                      </div>
                      <p className="text-xs text-zinc-500">
                        Connect ChatGPT ({codexAuth.model || "gpt-6-luna"}) in Settings
                      </p>
                    </>
                  )}
                </Card>

                <Card className="p-4 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Ollama Local LLM</span>
                    <Terminal className="w-4 h-4 text-zinc-500" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold text-zinc-100">
                      {ollama.running ? "Connected" : "Offline"}
                    </span>
                    <Badge tone={ollama.running ? "success" : "warning"}>
                      {ollama.running ? `${ollama.models.length} models` : "Cloud Fallback"}
                    </Badge>
                  </div>
                </Card>

                <Card className="p-4 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Hardware Profile</span>
                    <Cpu className="w-4 h-4 text-zinc-500" />
                  </div>
                  <div className="text-lg font-semibold text-zinc-100">
                    {hardware ? `${hardware.cpu_cores} Cores · ${hardware.os}` : "Detecting..."}
                  </div>
                  <p className="text-xs text-zinc-500">
                    {hardware?.has_nvidia_gpu ? "NVIDIA GPU Ready" : "CPU + Free Cloud Hybrid"}
                  </p>
                </Card>

                <Card className="p-4 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Local Memory Store</span>
                    <Database className="w-4 h-4 text-zinc-500" />
                  </div>
                  <div className="text-lg font-semibold text-zinc-100">
                    {memories.length} Entries
                  </div>
                  <p className="text-xs text-zinc-500">Stored locally in SQLite</p>
                </Card>
              </motion.div>

              <Card className="p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">
                  Installed Local Models
                </h2>
                {ollama.models.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    No Ollama models found on 127.0.0.1:11434. Pull a model or add a free Groq/Gemini/OpenRouter key in Settings.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {ollama.models.map((m) => (
                      <Badge key={m} tone="neutral" className="font-mono">
                        {m}
                      </Badge>
                    ))}
                  </div>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="logs" forceMount className="outline-none data-[state=inactive]:hidden">
              <LiveLogs />
            </TabsContent>

            <TabsContent value="agents" className="outline-none">
              <AgentList />
            </TabsContent>

            <TabsContent value="memory" className="space-y-4 outline-none">
              <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-400">{memories.length} local memories</p>
                <Button variant="destructive" size="sm" onClick={handleClearMemory}>
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear All
                </Button>
              </div>
              {memories.length === 0 ? (
                <Card className="p-6 text-center text-xs text-zinc-500">No memories stored yet.</Card>
              ) : (
                <div className="space-y-2">
                  {memories.map((m) => (
                    <Card key={m.id} className="p-3.5 text-xs text-zinc-200">
                      {m.content}
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="cron" className="outline-none">
              <CronManager />
            </TabsContent>

            <TabsContent value="settings" className="space-y-6 outline-none">
              <AudioSettings />
              <ModelSettings
                config={config}
                hardware={hardwareProfile}
                localModels={localModels}
                onSaveConfig={handleSaveConfig}
                onDownloadModel={handleDownloadModel}
              />
              <HotkeySettings
                hotkeys={config.hotkeys}
                onSaveHotkeys={handleSaveHotkeys}
              />
              <McpSettings
                servers={mcpServers}
                onAddServer={handleAddMcpServer}
                onRemoveServer={handleRemoveMcpServer}
                onTestConnection={handleTestMcp}
              />
            </TabsContent>
          </div>
        </main>
      </Tabs>
    </TooltipProvider>
  );
};
