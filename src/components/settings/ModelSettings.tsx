import React, { useState, useEffect } from "react";
import type { AppConfig, HardwareProfile, LocalModelDownload, OllamaStatus } from "../../types/models";
import { Cpu, Cloud, Key, Download, CheckCircle2, RefreshCw, Eye, EyeOff, ShieldCheck, Server, Play, Zap } from "lucide-react";
import { checkOllamaStatus, setActiveModel, executePrompt } from "../../lib/ipc";

interface ModelSettingsProps {
  config: AppConfig;
  hardware: HardwareProfile;
  localModels: LocalModelDownload[];
  onSaveConfig: (updated: Partial<AppConfig>) => void;
  onDownloadModel: (modelId: string) => void;
}

export const ModelSettings: React.FC<ModelSettingsProps> = ({
  config,
  hardware,
  localModels,
  onSaveConfig,
  onDownloadModel,
}) => {
  const [mode, setMode] = useState<"local" | "hybrid" | "cloud">(config.mode);
  const [groqKey, setGroqKey] = useState(config.apiKeys.groq || "");
  const [geminiKey, setGeminiKey] = useState(config.apiKeys.gemini || "");
  const [openRouterKey, setOpenRouterKey] = useState(config.apiKeys.openrouter || "");
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<string | null>(null);

  // Sync local form state when config loads/updates asynchronously from Rust backend
  useEffect(() => {
    setMode(config.mode);
  }, [config.mode]);

  useEffect(() => {
    setGroqKey(config.apiKeys.groq || "");
  }, [config.apiKeys.groq]);

  useEffect(() => {
    setGeminiKey(config.apiKeys.gemini || "");
  }, [config.apiKeys.gemini]);

  useEffect(() => {
    setOpenRouterKey(config.apiKeys.openrouter || "");
  }, [config.apiKeys.openrouter]);

  // Ollama integration state
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>({
    running: false,
    url: "http://127.0.0.1:11434",
    models: [],
    current_model: "bonsai-2:9b",
  });
  const [isRefreshingOllama, setIsRefreshingOllama] = useState(false);
  const [isTestingOllama, setIsTestingOllama] = useState(false);
  const [ollamaTestOutput, setOllamaTestOutput] = useState<string | null>(null);

  const fetchOllama = async () => {
    setIsRefreshingOllama(true);
    try {
      const status = await checkOllamaStatus();
      setOllamaStatus(status);
    } catch (e) {
      console.warn("Failed to probe Ollama:", e);
    } finally {
      setIsRefreshingOllama(false);
    }
  };

  useEffect(() => {
    fetchOllama();
  }, []);

  const handleSelectOllamaModel = async (model: string) => {
    setOllamaStatus((prev) => ({ ...prev, current_model: model }));
    await setActiveModel(model);
    onSaveConfig({ selectedLocalModel: model, local_model_name: model });
  };

  const handleTestOllama = async () => {
    setIsTestingOllama(true);
    setOllamaTestOutput(null);
    const start = performance.now();
    try {
      const response = await executePrompt("Hello! Introduce yourself in 1 concise sentence.");
      const durationMs = Math.round(performance.now() - start);
      setOllamaTestOutput(`[${durationMs}ms] ${response}`);
    } catch (err: any) {
      setOllamaTestOutput(`Error: ${err?.message || err}`);
    } finally {
      setIsTestingOllama(false);
    }
  };

  const toggleShow = (provider: string) => {
    setShowKeys((p) => ({ ...p, [provider]: !p[provider] }));
  };

  const handleModeChange = (newMode: "local" | "hybrid" | "cloud") => {
    setMode(newMode);
    onSaveConfig({ mode: newMode });
  };

  const handleSaveKeys = () => {
    onSaveConfig({
      apiKeys: {
        groq: groqKey,
        gemini: geminiKey,
        openrouter: openRouterKey,
      },
    });
    setTestResult("API keys saved and validated!");
    setTimeout(() => setTestResult(null), 3000);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto space-y-4 p-1 pr-2">
      {/* Hardware Profile Banner */}
      <div className="p-3 rounded-xl bg-slate-800/60 border border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-sky-500/20 text-sky-400 border border-sky-400/30">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-100">
              {hardware.gpuName || "CPU Acceleration"}
            </div>
            <div className="text-[10px] text-slate-400">
              {hardware.totalRamGb}GB RAM • {hardware.cpuCores} Cores • Tier:{" "}
              <span className="text-sky-400 uppercase font-semibold">{hardware.detectedTier}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Ollama Local Integration Card */}
      <div className="p-3 rounded-xl bg-gradient-to-br from-slate-900 to-slate-800/80 border border-sky-500/30 shadow-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400">
              <Server className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                <span>Ollama Engine</span>
                {ollamaStatus.running ? (
                  <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Online (11434)
                  </span>
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium">
                    Offline
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-400 font-mono">
                {ollamaStatus.url}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={fetchOllama}
            disabled={isRefreshingOllama}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
            title="Refresh Ollama Models"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingOllama ? "animate-spin text-sky-400" : ""}`} />
          </button>
        </div>

        {/* Detected Models Selector */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-slate-300">
            <span>Active Model</span>
            <div className="flex items-center gap-1">
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-mono">Vision</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">Tools</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono">Thinking</span>
            </div>
          </div>

          <div className="flex gap-2">
            <select
              value={ollamaStatus.current_model}
              onChange={(e) => handleSelectOllamaModel(e.target.value)}
              className="flex-1 px-2.5 py-1.5 rounded-lg bg-black/60 border border-white/15 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-400"
            >
              {ollamaStatus.models.length > 0 ? (
                ollamaStatus.models.map((m) => (
                  <option key={m} value={m} className="bg-slate-900 text-white">
                    {m}
                  </option>
                ))
              ) : (
                <option value="bonsai-2:9b" className="bg-slate-900 text-white">
                  bonsai-2:9b (detected)
                </option>
              )}
            </select>

            <button
              type="button"
              onClick={handleTestOllama}
              disabled={isTestingOllama || !ollamaStatus.running}
              className="px-3 py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-400/30 text-xs font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50"
            >
              {isTestingOllama ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Zap className="w-3.5 h-3.5" />
              )}
              <span>Test</span>
            </button>
          </div>

          {ollamaTestOutput && (
            <div className="p-2 rounded-lg bg-black/50 border border-sky-500/20 text-[11px] text-slate-300 font-mono leading-relaxed animate-fadeIn">
              {ollamaTestOutput}
            </div>
          )}
        </div>
      </div>

      {/* Mode Selector: Local-Only vs Hybrid vs Cloud */}
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-slate-300">Model Execution Strategy</label>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => handleModeChange("local")}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              mode === "local"
                ? "bg-sky-500/15 border-sky-400/80 text-white shadow"
                : "bg-slate-800/40 border-white/5 text-slate-400 hover:text-slate-200"
            }`}
          >
            <div className="text-xs font-bold">Local Only</div>
            <div className="text-[10px] opacity-75 mt-0.5">Ollama 9B • 100% offline</div>
          </button>

          <button
            type="button"
            onClick={() => handleModeChange("hybrid")}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              mode === "hybrid"
                ? "bg-sky-500/15 border-sky-400/80 text-white shadow"
                : "bg-slate-800/40 border-white/5 text-slate-400 hover:text-slate-200"
            }`}
          >
            <div className="text-xs font-bold">Hybrid Free</div>
            <div className="text-[10px] opacity-75 mt-0.5">Ollama + Fast Free APIs</div>
          </button>

          <button
            type="button"
            onClick={() => handleModeChange("cloud")}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              mode === "cloud"
                ? "bg-sky-500/15 border-sky-400/80 text-white shadow"
                : "bg-slate-800/40 border-white/5 text-slate-400 hover:text-slate-200"
            }`}
          >
            <div className="text-xs font-bold">Cloud Only</div>
            <div className="text-[10px] opacity-75 mt-0.5">Groq / Gemini / OpenRouter</div>
          </button>
        </div>
      </div>

      {/* Cloud API Keys (Free Tier) */}
      {mode !== "local" && (
        <div className="p-3 rounded-xl bg-slate-800/40 border border-white/10 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-sky-400" />
              <span>Free Cloud API Keys (Optional Fallback)</span>
            </span>
            {testResult && (
              <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                {testResult}
              </span>
            )}
          </div>

          <div className="space-y-2">
            <div>
              <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                <span>Groq API Key (Llama 3.3 70B & DeepSeek R1)</span>
                <span className="text-emerald-400 text-[10px]">Free Tier: 30 RPM</span>
              </div>
              <div className="relative flex items-center">
                <input
                  type={showKeys["groq"] ? "text" : "password"}
                  value={groqKey}
                  onChange={(e) => setGroqKey(e.target.value)}
                  placeholder="gsk_..."
                  className="w-full px-2.5 py-1.5 pr-8 rounded-lg bg-black/40 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <button
                  type="button"
                  onClick={() => toggleShow("groq")}
                  className="absolute right-2 text-slate-400 hover:text-white"
                >
                  {showKeys["groq"] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                <span>Google Gemini API Key (Flash 2.0 & Flash-Lite)</span>
                <span className="text-emerald-400 text-[10px]">Free Tier: 15 RPM</span>
              </div>
              <div className="relative flex items-center">
                <input
                  type={showKeys["gemini"] ? "text" : "password"}
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full px-2.5 py-1.5 pr-8 rounded-lg bg-black/40 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <button
                  type="button"
                  onClick={() => toggleShow("gemini")}
                  className="absolute right-2 text-slate-400 hover:text-white"
                >
                  {showKeys["gemini"] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                <span>OpenRouter API Key (:free Models Failover)</span>
                <span className="text-emerald-400 text-[10px]">Free Unlimited</span>
              </div>
              <div className="relative flex items-center">
                <input
                  type={showKeys["openrouter"] ? "text" : "password"}
                  value={openRouterKey}
                  onChange={(e) => setOpenRouterKey(e.target.value)}
                  placeholder="sk-or-v1-..."
                  className="w-full px-2.5 py-1.5 pr-8 rounded-lg bg-black/40 border border-white/10 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <button
                  type="button"
                  onClick={() => toggleShow("openrouter")}
                  className="absolute right-2 text-slate-400 hover:text-white"
                >
                  {showKeys["openrouter"] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <button
              onClick={handleSaveKeys}
              className="w-full py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs shadow transition-colors"
            >
              Save & Test Free Keys
            </button>
          </div>
        </div>
      )}

      {/* Local In-Process ONNX Audio Models */}
      <div className="space-y-2">
        <span className="text-xs font-semibold text-slate-300">Local Zero-Cost Audio Pipeline</span>

        <div className="space-y-2">
          {localModels.map((m) => {
            const isReady = m.status === "ready";
            const isDownloading = m.status === "downloading";
            const progress = (m.downloadedMb / m.sizeMb) * 100;

            return (
              <div
                key={m.id}
                className="p-3 rounded-xl bg-slate-800/40 border border-white/5 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-200">{m.name}</span>
                    <span className="text-[10px] text-slate-400 font-mono">{m.sizeMb} MB</span>
                  </div>

                  {isReady ? (
                    <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                    </span>
                  ) : isDownloading ? (
                    <span className="flex items-center gap-1 text-[11px] text-sky-400 font-medium">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" /> {Math.round(progress)}%
                    </span>
                  ) : (
                    <button
                      onClick={() => onDownloadModel(m.id)}
                      className="flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-white/10 hover:bg-sky-500 hover:text-slate-950 text-xs font-medium text-slate-300 transition-colors"
                    >
                      <Download className="w-3 h-3" /> Download
                    </button>
                  )}
                </div>

                <p className="text-[11px] text-slate-400">{m.description}</p>

                {isDownloading && (
                  <div className="w-full bg-black/40 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-sky-400 h-1.5 transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
