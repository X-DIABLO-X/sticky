import React, { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  invokeCommand,
  listenEvent,
  emitEvent,
  isTauri,
} from "../lib/ipc";
import type {
  AppConfig,
  HardwareProfile,
  Agent,
  CronJob,
  Memory,
  LocalModelDownload,
  McpServerConfig,
} from "../types/models";
import { AgentList } from "../components/agents/AgentList";
import { AgentChat } from "../components/agents/AgentChat";
import { CronManager } from "../components/agents/CronManager";
import { ModelSettings } from "../components/settings/ModelSettings";
import { HotkeySettings } from "../components/settings/HotkeySettings";
import { McpSettings } from "../components/settings/McpSettings";
import {
  Mic,
  FileText,
  ChevronDown,
  ChevronUp,
  Bot,
  Clock,
  HardDrive,
  Settings,
  Sparkles,
  Search,
  Plus,
  Trash2,
  Compass,
} from "lucide-react";

export const PillWindow: React.FC = () => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"agents" | "cron" | "memory" | "settings">("agents");
  const [settingsSubTab, setSettingsSubTab] = useState<"models" | "hotkeys" | "mcp">("models");
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);

  // Core App State
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [localModels, setLocalModels] = useState<LocalModelDownload[]>([]);
  const [isTalking, setIsTalking] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [memorySearch, setMemorySearch] = useState("");

  // Dynamically resize native OS window when expanding/collapsing drawer
  useEffect(() => {
    if (isTauri()) {
      try {
        const win = getCurrentWindow();
        if (isExpanded) {
          win.setSize(new LogicalSize(440, 560));
        } else {
          win.setSize(new LogicalSize(320, 56));
        }
      } catch (err) {
        console.warn("Could not resize pill window:", err);
      }
    }
  }, [isExpanded]);

  useEffect(() => {
    // Initial fetch from backend
    async function loadData() {
      try {
        const [loadedConfig, loadedHw, loadedAgents, loadedCron, loadedMem, loadedModels] =
          await Promise.all([
            invokeCommand<AppConfig>("get_config"),
            invokeCommand<HardwareProfile>("get_hardware_profile"),
            invokeCommand<Agent[]>("get_agents"),
            invokeCommand<CronJob[]>("get_cron_jobs"),
            invokeCommand<Memory[]>("get_memories"),
            invokeCommand<LocalModelDownload[]>("get_local_models"),
          ]);

        setConfig(loadedConfig);
        setHardware(loadedHw);
        setAgents(loadedAgents);
        setCronJobs(loadedCron);
        setMemories(loadedMem);
        setLocalModels(loadedModels);
      } catch (err) {
        console.error("Failed to load initial data in PillWindow:", err);
      }
    }
    loadData();

    // Listen for agent status and voice triggers
    const unlistenStatus = listenEvent<{ agentId: string; status: any }>(
      "agent_status_change",
      (ev) => {
        setAgents((prev) =>
          prev.map((a) => (a.id === ev.agentId ? { ...a, status: ev.status } : a))
        );
      }
    );

    const unlistenTalkState = listenEvent<string>("talk:state", (st) => {
      setIsTalking(st === "Listening" || st === "Transcribing" || st === "Thinking" || st === "Speaking");
    });

    return () => {
      unlistenStatus.then((un) => un());
      unlistenTalkState.then((un) => un());
    };
  }, []);

  const activeAgent =
    agents.find((a) => a.id === config?.activeAgentId) || agents[0] || {
      id: "clicky-default",
      name: "Clicky",
      avatar: "⚡",
      role: "Universal Assistant",
      model: config?.local_model_name || "bonsai-2:9b",
      status: "idle",
    };

  const toggleTalk = async () => {
    setIsTalking(!isTalking);
    await invokeCommand("toggle_talk", { active: !isTalking });
  };

  const toggleDictation = async () => {
    setIsDictating(!isDictating);
    await invokeCommand("toggle_dictation", { active: !isDictating });
  };

  const handleSelectAgent = async (agentId: string) => {
    if (!config) return;
    const updated = { ...config, activeAgentId: agentId };
    setConfig(updated);
    await invokeCommand("save_config", { config: updated });
  };

  const handleUpdateConfig = async (patch: Partial<AppConfig>) => {
    if (!config) return;
    const updated = { ...config, ...patch };
    setConfig(updated);
    await invokeCommand("save_config", { config: updated });
  };

  const filteredMemories = memories.filter(
    (m) =>
      m.key.toLowerCase().includes(memorySearch.toLowerCase()) ||
      m.value.toLowerCase().includes(memorySearch.toLowerCase())
  );

  return (
    <div className="flex flex-col items-center w-full min-h-screen pt-2 select-none">
      {/* Top Collapsed Pill (320x44px) */}
      <div
        className={`relative z-50 flex items-center justify-between px-3.5 h-[44px] rounded-full transition-all duration-300 ${
          isExpanded
            ? "w-[440px] bg-slate-900 border border-sky-400/50 shadow-2xl"
            : "w-[320px] glass-pill cursor-pointer hover:border-sky-400/60"
        }`}
        onClick={() => !isExpanded && setIsExpanded(true)}
      >
        {/* Active Agent Info */}
        <div className="flex items-center gap-2">
          <div className="relative flex items-center justify-center w-7 h-7 rounded-full bg-slate-800 text-sm border border-white/10 shadow-inner">
            <span>{activeAgent.avatar}</span>
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-slate-900 ${
                isTalking || isDictating
                  ? "bg-amber-400 animate-ping"
                  : activeAgent.status === "busy"
                  ? "bg-sky-400 animate-pulse"
                  : "bg-emerald-400"
              }`}
            />
          </div>

          <div className="flex flex-col">
            <span className="text-xs font-bold text-slate-100 leading-tight">
              {activeAgent.name}
            </span>
            <span className="text-[10px] text-sky-400/90 font-mono leading-tight">
              {isTalking ? "Listening..." : isDictating ? "Dictating..." : activeAgent.model}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {/* Talk Button */}
          <button
            onClick={toggleTalk}
            className={`p-1.5 rounded-full transition-all ${
              isTalking
                ? "bg-rose-500 text-white shadow-md shadow-rose-500/40 animate-pulse"
                : "bg-white/5 hover:bg-sky-500/20 text-slate-300 hover:text-sky-300"
            }`}
            title="Push to Talk"
          >
            <Mic className="w-4 h-4" />
          </button>

          {/* Dictation Button */}
          <button
            onClick={toggleDictation}
            className={`p-1.5 rounded-full transition-all ${
              isDictating
                ? "bg-amber-500 text-slate-950 shadow-md shadow-amber-500/40 font-bold"
                : "bg-white/5 hover:bg-amber-500/20 text-slate-300 hover:text-amber-300"
            }`}
            title="Active Caret Dictation"
          >
            <FileText className="w-4 h-4" />
          </button>

          {/* Open Main Dashboard */}
          <button
            onClick={() => invokeCommand("open_dashboard")}
            className="p-1.5 rounded-full bg-white/5 hover:bg-indigo-500/20 text-slate-300 hover:text-indigo-300 transition-all"
            title="Open Control Center Dashboard"
          >
            <Compass className="w-4 h-4" />
          </button>

          {/* Expand/Collapse Toggle Chevron */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded-full text-slate-400 hover:text-white transition-colors"
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Expanded Drawer (440x516px) */}
      {isExpanded && config && hardware && (
        <div className="w-[440px] h-[516px] -mt-3 pt-6 px-4 pb-4 rounded-b-3xl glass-panel border border-t-0 border-sky-400/40 shadow-2xl flex flex-col z-40 animate-float">
          {/* Tab Navigation */}
          <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-black/40 border border-white/5 shrink-0 mb-3">
            <button
              onClick={() => {
                setActiveTab("agents");
                setChatAgent(null);
              }}
              className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === "agents"
                  ? "bg-sky-500 text-slate-950 shadow-md"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Bot className="w-3.5 h-3.5" />
              <span>Agents</span>
            </button>

            <button
              onClick={() => {
                setActiveTab("cron");
                setChatAgent(null);
              }}
              className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === "cron"
                  ? "bg-sky-500 text-slate-950 shadow-md"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Cron</span>
            </button>

            <button
              onClick={() => {
                setActiveTab("memory");
                setChatAgent(null);
              }}
              className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === "memory"
                  ? "bg-sky-500 text-slate-950 shadow-md"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <HardDrive className="w-3.5 h-3.5" />
              <span>Memory</span>
            </button>

            <button
              onClick={() => {
                setActiveTab("settings");
                setChatAgent(null);
              }}
              className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === "settings"
                  ? "bg-sky-500 text-slate-950 shadow-md"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Settings</span>
            </button>
          </div>

          {/* Tab Body */}
          <div className="flex-1 overflow-hidden">
            {activeTab === "agents" &&
              (chatAgent ? (
                <AgentChat agent={chatAgent} onBack={() => setChatAgent(null)} />
              ) : (
                <AgentList
                  agents={agents}
                  activeAgentId={config.activeAgentId}
                  onSelectAgent={handleSelectAgent}
                  onOpenChat={(a) => setChatAgent(a)}
                  onCreateAgent={() => {
                    const newAgent: Agent = {
                      id: `clicky-${Date.now()}`,
                      name: "Custom Clicky",
                      avatar: "✨",
                      role: "Custom Specialized Workflow Agent",
                      model: config?.local_model_name || "bonsai-2:9b",
                      status: "idle",
                      memoryCount: 0,
                    };
                    setAgents((p) => [...p, newAgent]);
                  }}
                />
              ))}

            {activeTab === "cron" && (
              <CronManager
                cronJobs={cronJobs}
                agents={agents}
                onToggleJob={(id, enabled) =>
                  setCronJobs((p) =>
                    p.map((j) => (j.id === id ? { ...j, enabled } : j))
                  )
                }
                onRunNow={(id) => {
                  console.log("Triggered cron run:", id);
                }}
                onAddJob={(newJob) =>
                  setCronJobs((p) => [...p, { ...newJob, id: `cron-${Date.now()}` }])
                }
                onDeleteJob={(id) => setCronJobs((p) => p.filter((j) => j.id !== id))}
              />
            )}

            {activeTab === "memory" && (
              <div className="flex flex-col h-full overflow-hidden space-y-2.5">
                {/* Search Bar */}
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/40 border border-white/10 shrink-0">
                  <Search className="w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={memorySearch}
                    onChange={(e) => setMemorySearch(e.target.value)}
                    placeholder="Search persistent memories & facts..."
                    className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
                  />
                </div>

                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                  {filteredMemories.map((mem) => (
                    <div
                      key={mem.id}
                      className="p-2.5 rounded-xl bg-slate-800/40 border border-white/5 space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-sky-400 font-mono">{mem.key}</span>
                        <span className="text-[10px] uppercase font-bold px-1.5 py-0.2 rounded bg-white/5 text-slate-400">
                          {mem.scope}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 leading-snug">{mem.value}</p>
                      <div className="text-[9px] text-slate-500 text-right">{mem.updatedAt}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "settings" && (
              <div className="flex flex-col h-full overflow-hidden">
                {/* Settings Sub-Tab Navigation */}
                <div className="flex gap-2 border-b border-white/10 pb-2 mb-2 shrink-0">
                  <button
                    onClick={() => setSettingsSubTab("models")}
                    className={`text-xs font-medium px-2 py-0.5 rounded transition-colors ${
                      settingsSubTab === "models"
                        ? "bg-white/10 text-sky-400 font-bold"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    AI Models & Keys
                  </button>
                  <button
                    onClick={() => setSettingsSubTab("hotkeys")}
                    className={`text-xs font-medium px-2 py-0.5 rounded transition-colors ${
                      settingsSubTab === "hotkeys"
                        ? "bg-white/10 text-sky-400 font-bold"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    Hotkeys
                  </button>
                  <button
                    onClick={() => setSettingsSubTab("mcp")}
                    className={`text-xs font-medium px-2 py-0.5 rounded transition-colors ${
                      settingsSubTab === "mcp"
                        ? "bg-white/10 text-sky-400 font-bold"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    MCP Tools
                  </button>
                </div>

                <div className="flex-1 overflow-hidden">
                  {settingsSubTab === "models" && (
                    <ModelSettings
                      config={config}
                      hardware={hardware}
                      localModels={localModels}
                      onSaveConfig={handleUpdateConfig}
                      onDownloadModel={(mId) => {
                        setLocalModels((p) =>
                          p.map((m) =>
                            m.id === mId ? { ...m, status: "downloading", downloadedMb: 10 } : m
                          )
                        );
                      }}
                    />
                  )}

                  {settingsSubTab === "hotkeys" && (
                    <HotkeySettings
                      hotkeys={config.hotkeys}
                      onSaveHotkeys={(updated) => handleUpdateConfig({ hotkeys: updated })}
                    />
                  )}

                  {settingsSubTab === "mcp" && (
                    <McpSettings
                      servers={config.mcpServers}
                      onAddServer={(s) =>
                        handleUpdateConfig({ mcpServers: [...config.mcpServers, s] })
                      }
                      onRemoveServer={(id) =>
                        handleUpdateConfig({
                          mcpServers: config.mcpServers.filter((s) => s.id !== id),
                        })
                      }
                      onTestConnection={async () => true}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
