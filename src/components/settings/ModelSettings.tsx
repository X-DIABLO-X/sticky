import React, { useState, useEffect, useRef } from "react";
import type {
  AppConfig,
  CodexAuthStatus,
  HardwareProfile,
  LocalModelDownload,
  OllamaStatus,
} from "../../types/models";
import {
  Cpu,
  Key,
  Download,
  CheckCircle2,
  RefreshCw,
  Eye,
  EyeOff,
  Server,
  Zap,
  Sparkles,
  LogIn,
  LogOut,
  FileDown,
  AlertCircle,
  Check,
} from "lucide-react";
import {
  checkOllamaStatus,
  setActiveModel,
  executePrompt,
  getCodexAuthStatus,
  startCodexOAuthLogin,
  logoutCodexAuth,
  importCodexCliAuth,
  setCodexSettings,
  testCodexLlm,
  listenEvent,
} from "../../lib/ipc";
import { Switch } from "../ui/primitives";

const CODEX_MODEL_PRESETS = [
  { value: "gpt-6-luna", label: "gpt-6-luna — GPT-6 Luna · Ultra-Cheap Multimodal" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
] as const;

const CODEX_PRESET_VALUES: readonly string[] = CODEX_MODEL_PRESETS.map((p) => p.value);

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

  // ChatGPT Codex OAuth (LLM Only) state
  const [codexStatus, setCodexStatus] = useState<CodexAuthStatus>({
    authenticated: false,
    email: null,
    account_id: null,
    expires_at: null,
    auth_path: "",
    model: config.codex_model_name || "gpt-6-luna",
    codex_only: config.use_chatgpt_codex_only ?? true,
  });
  const [codexModelInput, setCodexModelInput] = useState<string>(config.codex_model_name || "gpt-6-luna");
  const [isRefreshingCodex, setIsRefreshingCodex] = useState(false);
  const [isSigningInCodex, setIsSigningInCodex] = useState(false);
  const [isImportingCodex, setIsImportingCodex] = useState(false);
  const [isLoggingOutCodex, setIsLoggingOutCodex] = useState(false);
  const [isSavingCodexSettings, setIsSavingCodexSettings] = useState(false);
  const [isTestingCodex, setIsTestingCodex] = useState(false);
  const [codexTestOutput, setCodexTestOutput] = useState<string | null>(null);
  const [codexFeedback, setCodexFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const customModelInputRef = useRef<HTMLInputElement | null>(null);

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

  const applyCodexStatus = (status: CodexAuthStatus) => {
    const resolvedModel = status.model?.trim() || "gpt-6-luna";
    setCodexStatus({ ...status, model: resolvedModel });
    setCodexModelInput(resolvedModel);
  };

  const fetchCodexStatus = async () => {
    setIsRefreshingCodex(true);
    try {
      const status = await getCodexAuthStatus();
      applyCodexStatus(status);
    } catch (e) {
      console.warn("Failed to probe ChatGPT Codex auth status:", e);
    } finally {
      setIsRefreshingCodex(false);
    }
  };

  useEffect(() => {
    let active = true;
    fetchCodexStatus();

    const unlistenPromise = listenEvent<CodexAuthStatus>("codex:auth_changed", (payload) => {
      if (!active || !payload) return;
      applyCodexStatus(payload);
    });

    return () => {
      active = false;
      unlistenPromise.then((unlisten) => unlisten && unlisten());
    };
  }, []);

  const showCodexNotice = (type: "success" | "error", message: string) => {
    setCodexFeedback({ type, message });
  };

  const handleCodexOAuthLogin = async () => {
    setIsSigningInCodex(true);
    setCodexFeedback(null);
    try {
      const status = await startCodexOAuthLogin();
      applyCodexStatus(status);
      showCodexNotice(
        "success",
        status.email
          ? `Connected to ChatGPT as ${status.email}.`
          : "Connected to ChatGPT Codex OAuth."
      );
    } catch (err) {
      showCodexNotice("error", err instanceof Error ? err.message : String(err));
    } finally {
      setIsSigningInCodex(false);
    }
  };

  const handleImportCodexCli = async () => {
    setIsImportingCodex(true);
    setCodexFeedback(null);
    try {
      const status = await importCodexCliAuth();
      applyCodexStatus(status);
      showCodexNotice(
        "success",
        status.authenticated
          ? `Imported Codex CLI auth${status.email ? ` (${status.email})` : ""}.`
          : "Codex CLI auth file checked, but no active session was found."
      );
    } catch (err) {
      showCodexNotice("error", err instanceof Error ? err.message : String(err));
    } finally {
      setIsImportingCodex(false);
    }
  };

  const handleLogoutCodex = async () => {
    setIsLoggingOutCodex(true);
    setCodexFeedback(null);
    setCodexTestOutput(null);
    try {
      const status = await logoutCodexAuth();
      applyCodexStatus(status);
      showCodexNotice("success", "Signed out of ChatGPT Codex.");
    } catch (err) {
      showCodexNotice("error", err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoggingOutCodex(false);
    }
  };

  const handleSaveCodexSettings = async (nextModel?: string, nextCodexOnly?: boolean) => {
    const targetModel = (nextModel ?? codexModelInput).trim() || "gpt-6-luna";
    const targetCodexOnly = nextCodexOnly ?? codexStatus.codex_only;

    setIsSavingCodexSettings(true);
    setCodexFeedback(null);
    try {
      const updated = await setCodexSettings(targetModel, targetCodexOnly);
      applyCodexStatus(updated);
      showCodexNotice(
        "success",
        `Saved Codex settings (${updated.model || targetModel}${updated.codex_only ? " · ChatGPT Only" : ""}).`
      );
    } catch (err) {
      showCodexNotice("error", err instanceof Error ? err.message : String(err));
    } finally {
      setIsSavingCodexSettings(false);
    }
  };

  const handleSelectCodexPreset = (value: string) => {
    if (value === "__custom__") {
      customModelInputRef.current?.focus();
      customModelInputRef.current?.select();
      return;
    }
    setCodexModelInput(value);
    if (value !== codexStatus.model) {
      void handleSaveCodexSettings(value, codexStatus.codex_only);
    }
  };

  const handleCustomModelBlur = () => {
    const trimmed = codexModelInput.trim();
    if (!trimmed) {
      setCodexModelInput(codexStatus.model || "gpt-6-luna");
      return;
    }
    if (trimmed !== codexStatus.model) {
      void handleSaveCodexSettings(trimmed, codexStatus.codex_only);
    }
  };

  const handleToggleCodexOnly = (checked: boolean) => {
    setCodexStatus((prev) => ({ ...prev, codex_only: checked }));
    void handleSaveCodexSettings(codexStatus.model || "gpt-6-luna", checked);
  };

  const handleTestCodexLlm = async () => {
    setIsTestingCodex(true);
    setCodexTestOutput(null);
    setCodexFeedback(null);
    try {
      const res = await testCodexLlm("Hello! Confirm connection in one short sentence.");
      setCodexTestOutput(`[${res.latency_ms}ms] ${res.reply}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showCodexNotice("error", `Test failed: ${message}`);
    } finally {
      setIsTestingCodex(false);
    }
  };

  const activeCodexModel = codexStatus.model || "gpt-6-luna";
  const selectedPresetValue = CODEX_PRESET_VALUES.includes(codexModelInput.trim())
    ? codexModelInput.trim()
    : "__custom__";
  const codexIdentity = codexStatus.email || codexStatus.account_id || null;
  const hasUnsavedModelDraft =
    codexModelInput.trim().length > 0 && codexModelInput.trim() !== activeCodexModel;

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

      {/* ChatGPT Codex OAuth (LLM Only) Card */}
      <div className="p-3.5 rounded-xl bg-gradient-to-br from-emerald-950/35 via-slate-900 to-slate-900/90 border border-emerald-500/35 shadow-lg space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="p-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 shrink-0 mt-0.5">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-bold text-slate-100">
                  ChatGPT Codex Auth (LLM Only)
                </span>
                {codexStatus.authenticated ? (
                  <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/35 font-medium max-w-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    <span>Connected</span>
                    {codexIdentity && (
                      <span className="text-emerald-200/90 font-mono truncate max-w-[180px]" title={codexIdentity}>
                        · {codexIdentity}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium">
                    Not Signed In
                  </span>
                )}
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800/90 text-zinc-300 border border-white/10 font-medium">
                  LLM Only · Local STT/TTS
                </span>
              </div>
              {codexStatus.auth_path && (
                <div className="text-[10px] text-slate-400 font-mono truncate" title={codexStatus.auth_path}>
                  {codexStatus.auth_path}
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={fetchCodexStatus}
            disabled={isRefreshingCodex}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors shrink-0"
            title="Refresh ChatGPT Codex Auth Status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingCodex ? "animate-spin text-emerald-400" : ""}`} />
          </button>
        </div>

        {/* Auth Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {!codexStatus.authenticated ? (
            <>
              <button
                type="button"
                onClick={handleCodexOAuthLogin}
                disabled={isSigningInCodex || isImportingCodex}
                className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-60"
              >
                {isSigningInCodex ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Waiting for ChatGPT browser sign-in...</span>
                  </>
                ) : (
                  <>
                    <LogIn className="w-3.5 h-3.5" />
                    <span>Sign in with ChatGPT</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleImportCodexCli}
                disabled={isSigningInCodex || isImportingCodex}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 border border-white/15 font-semibold text-xs flex items-center gap-1.5 transition-colors disabled:opacity-60"
              >
                {isImportingCodex ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                ) : (
                  <FileDown className="w-3.5 h-3.5 text-slate-300" />
                )}
                <span>Import Codex CLI Auth</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleTestCodexLlm}
                disabled={isTestingCodex || isSigningInCodex || isLoggingOutCodex}
                className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-400/35 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                {isTestingCodex ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Zap className="w-3.5 h-3.5 text-emerald-300" />
                )}
                <span>Test {activeCodexModel}</span>
              </button>

              <button
                type="button"
                onClick={handleCodexOAuthLogin}
                disabled={isSigningInCodex || isLoggingOutCodex}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 border border-white/15 text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSigningInCodex ? "animate-spin text-emerald-400" : ""}`} />
                <span>
                  {isSigningInCodex ? "Waiting for ChatGPT browser sign-in..." : "Re-authenticate"}
                </span>
              </button>

              <button
                type="button"
                onClick={handleLogoutCodex}
                disabled={isLoggingOutCodex || isSigningInCodex}
                className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/25 text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                {isLoggingOutCodex ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <LogOut className="w-3.5 h-3.5" />
                )}
                <span>Sign Out</span>
              </button>
            </>
          )}
        </div>

        {/* Codex Model Selector (Preset + Custom Slug) */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-slate-300">
            <span>Codex Model</span>
            <span className="text-[10px] text-emerald-400 font-mono">
              Active: {activeCodexModel}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={selectedPresetValue}
              onChange={(e) => handleSelectCodexPreset(e.target.value)}
              disabled={isSavingCodexSettings}
              className="w-full px-2.5 py-1.5 rounded-lg bg-black/60 border border-white/15 text-xs text-slate-100 font-mono focus:outline-none focus:border-emerald-400"
            >
              {CODEX_MODEL_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value} className="bg-slate-900 text-white">
                  {preset.label}
                </option>
              ))}
              <option value="__custom__" className="bg-slate-900 text-white">
                Custom model slug...
              </option>
            </select>

            <div className="flex gap-1.5">
              <input
                ref={customModelInputRef}
                type="text"
                value={codexModelInput}
                onChange={(e) => setCodexModelInput(e.target.value)}
                onBlur={handleCustomModelBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveCodexSettings(codexModelInput, codexStatus.codex_only);
                  }
                }}
                placeholder="gpt-6-luna"
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-black/60 border border-white/15 text-xs text-slate-100 font-mono focus:outline-none focus:border-emerald-400"
              />
              <button
                type="button"
                onClick={() => void handleSaveCodexSettings(codexModelInput, codexStatus.codex_only)}
                disabled={isSavingCodexSettings || (!hasUnsavedModelDraft && codexModelInput.trim().length > 0)}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-400/30 text-xs font-semibold flex items-center gap-1 transition-colors disabled:opacity-45 shrink-0"
                title="Save custom Codex model slug"
              >
                {isSavingCodexSettings ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                <span>Save</span>
              </button>
            </div>
          </div>
        </div>

        {/* Use ChatGPT Only for LLM Toggle */}
        <div className="p-2.5 rounded-lg bg-black/35 border border-white/10 flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-xs font-semibold text-slate-100">Use ChatGPT Only for LLM</div>
            <p className="text-[11px] text-slate-400 leading-snug">
              Routes all LLM prompts &amp; screen vision exclusively through ChatGPT Codex. Audio STT/TTS stays local.
            </p>
          </div>
          <Switch
            checked={codexStatus.codex_only}
            onCheckedChange={handleToggleCodexOnly}
            disabled={isSavingCodexSettings}
            className="data-[state=checked]:bg-emerald-500"
            aria-label="Use ChatGPT Only for LLM"
          />
        </div>

        {/* Inline Status / Error Feedback */}
        {codexFeedback && (
          <div
            className={`p-2 rounded-lg border text-[11px] flex items-start gap-1.5 leading-relaxed ${
              codexFeedback.type === "error"
                ? "bg-red-500/10 border-red-500/30 text-red-300"
                : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
            }`}
          >
            {codexFeedback.type === "error" ? (
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            )}
            <span className="break-words">{codexFeedback.message}</span>
          </div>
        )}

        {/* Test LLM Output */}
        {codexTestOutput && (
          <div className="p-2 rounded-lg bg-black/50 border border-emerald-500/25 text-[11px] text-slate-200 font-mono leading-relaxed">
            {codexTestOutput}
          </div>
        )}
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
