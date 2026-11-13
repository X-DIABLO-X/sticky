import React, { useState, useEffect, useRef } from "react";
import { invokeCommand } from "../lib/ipc";
import type { Agent } from "../types/models";
import {
  Sparkles,
  Paperclip,
  X,
  FileCode,
  Image,
  CornerDownLeft,
  Camera,
  ChevronDown,
  Bot,
} from "lucide-react";

interface DroppedFile {
  name: string;
  size: string;
  type: string;
}

export const QuickInputWindow: React.FC = () => {
  const [prompt, setPrompt] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [includeScreen, setIncludeScreen] = useState(true);
  const [files, setFiles] = useState<DroppedFile[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Focus input immediately on mount
    inputRef.current?.focus();

    async function loadAgents() {
      try {
        const loaded = await invokeCommand<Agent[]>("get_agents");
        if (loaded && loaded.length > 0) setAgents(loaded);
      } catch (e) {
        console.error("Failed to load agents in QuickInput:", e);
      }
    }
    loadAgents();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invokeCommand("hide_quick_input");
      } else if (e.key === "Tab") {
        e.preventDefault();
        setSelectedAgentIndex((prev) => (prev + 1) % (agents.length || 1));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [agents.length]);

  const activeAgent = agents[selectedAgentIndex] || {
    id: "clicky-code",
    name: "Coding Clicky",
    avatar: "⚡",
    model: "bonsai-2:9b",
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = () => {
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const newFiles: DroppedFile[] = Array.from(e.dataTransfer.files).map((f) => ({
        name: f.name,
        size: `${(f.size / 1024).toFixed(1)} KB`,
        type: f.type,
      }));
      setFiles((p) => [...p, ...newFiles]);
    }
  };

  const handleSubmit = async () => {
    if (!prompt.trim() && files.length === 0) return;

    await invokeCommand("submit_quick_prompt", {
      agentId: activeAgent.id,
      prompt,
      includeScreen,
      files,
    });

    setPrompt("");
    setFiles([]);
    await invokeCommand("hide_quick_input");
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="flex items-center justify-center w-full min-h-screen p-4 select-none"
    >
      <div
        className={`w-[620px] rounded-2xl glass-panel border shadow-2xl transition-all duration-200 overflow-hidden ${
          isDraggingOver
            ? "border-sky-400 ring-2 ring-sky-400/50 bg-sky-950/40"
            : "border-sky-400/30 hover:border-sky-400/50"
        }`}
      >
        {/* Main Input Row */}
        <div className="flex items-center px-4 py-3.5 gap-3 bg-slate-900/90">
          <Sparkles className="w-5 h-5 text-sky-400 shrink-0 animate-pulse" />

          <input
            ref={inputRef}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder={`Ask ${activeAgent.name} or type a command...`}
            className="flex-1 bg-transparent text-sm text-white placeholder-slate-400 font-medium focus:outline-none"
          />

          {/* Submit Action Pill */}
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim() && files.length === 0}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-20 disabled:pointer-events-none text-slate-950 font-bold text-xs shadow-md shadow-sky-500/20 transition-all hover:scale-105"
          >
            <span>Run</span>
            <CornerDownLeft className="w-3 h-3" />
          </button>
        </div>

        {/* Attached Files Strip */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 py-2 border-t border-white/5 bg-slate-950/40">
            {files.map((f, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/10 border border-white/10 text-xs text-slate-200"
              >
                {f.type.startsWith("image/") ? (
                  <Image className="w-3.5 h-3.5 text-sky-400" />
                ) : (
                  <FileCode className="w-3.5 h-3.5 text-purple-400" />
                )}
                <span className="truncate max-w-[140px] font-medium">{f.name}</span>
                <span className="text-[10px] text-slate-400 font-mono">({f.size})</span>
                <button
                  onClick={() => setFiles(files.filter((_, idx) => idx !== i))}
                  className="text-slate-400 hover:text-rose-400 ml-0.5"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Footer Configuration Badges & Hotkey Tips */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-black/40 border-t border-white/10 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            {/* Agent Selector Badge */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsAgentMenuOpen(!isAgentMenuOpen)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 font-medium transition-colors"
              >
                <span>{activeAgent.avatar}</span>
                <span>{activeAgent.name}</span>
                <ChevronDown className="w-3 h-3 text-slate-400" />
              </button>

              {isAgentMenuOpen && (
                <div className="absolute bottom-8 left-0 w-52 rounded-xl glass-panel border border-sky-400/40 p-1 shadow-2xl z-50 space-y-0.5 animate-float">
                  {agents.map((a, idx) => (
                    <button
                      key={a.id}
                      onClick={() => {
                        setSelectedAgentIndex(idx);
                        setIsAgentMenuOpen(false);
                      }}
                      className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-left text-xs hover:bg-white/10 text-slate-200 transition-colors"
                    >
                      <span>{a.avatar}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-slate-100 truncate">{a.name}</div>
                        <div className="text-[10px] text-sky-400 font-mono">{a.model}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Include Screen Context Toggle */}
            <button
              type="button"
              onClick={() => setIncludeScreen(!includeScreen)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs font-medium transition-colors ${
                includeScreen
                  ? "bg-sky-500/15 border-sky-400/40 text-sky-300"
                  : "bg-white/5 border-white/10 text-slate-400"
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              <span>{includeScreen ? "With active screen" : "No screenshot"}</span>
            </button>
          </div>

          {/* Hotkey Shortcuts Tip */}
          <div className="flex items-center gap-3 text-[11px] text-slate-500 font-mono">
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">
                Tab
              </kbd>{" "}
              cycle Clicky
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-slate-400">
                Esc
              </kbd>{" "}
              close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
