import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Terminal,
  Trash2,
  Copy,
  Check,
  Search,
  Filter,
  ArrowDownCircle,
  PauseCircle,
  PlayCircle,
  Mic,
  MessageSquare,
  Sparkles,
  Volume2,
  AlertCircle,
  Activity,
  Download,
} from "lucide-react";
import { listenEvent } from "../../lib/ipc";
import { Badge, Button, Card } from "../ui/primitives";
import { toast } from "sonner";

export type LogCategory = "all" | "talk" | "stt" | "llm" | "tts" | "overlay" | "error" | "system";

export interface LogEntry {
  id: string;
  timestamp: string;
  category: "talk" | "stt" | "llm" | "tts" | "overlay" | "error" | "system";
  title: string;
  content: string;
}

const CATEGORY_STYLES: Record<string, { label: string; badgeClass: string; icon: React.ReactNode }> = {
  talk: {
    label: "TALK",
    badgeClass: "bg-sky-500/15 text-sky-400 border border-sky-500/30",
    icon: <Mic className="w-3 h-3 text-sky-400" />,
  },
  stt: {
    label: "STT",
    badgeClass: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
    icon: <MessageSquare className="w-3 h-3 text-emerald-400" />,
  },
  llm: {
    label: "LLM",
    badgeClass: "bg-indigo-500/15 text-indigo-400 border border-indigo-500/30",
    icon: <Sparkles className="w-3 h-3 text-indigo-400" />,
  },
  tts: {
    label: "TTS",
    badgeClass: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
    icon: <Volume2 className="w-3 h-3 text-amber-400" />,
  },
  overlay: {
    label: "SOM",
    badgeClass: "bg-teal-500/15 text-teal-300 border border-teal-500/30",
    icon: <Activity className="w-3 h-3 text-teal-300" />,
  },
  error: {
    label: "ERROR",
    badgeClass: "bg-rose-500/15 text-rose-400 border border-rose-500/30",
    icon: <AlertCircle className="w-3 h-3 text-rose-400" />,
  },
  system: {
    label: "SYS",
    badgeClass: "bg-zinc-500/15 text-zinc-400 border border-zinc-500/30",
    icon: <Activity className="w-3 h-3 text-zinc-400" />,
  },
};

export const LiveLogs: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: "init",
      timestamp: new Date().toLocaleTimeString(),
      category: "system",
      title: "Pipeline Logger Ready",
      content: "Listening for real-time speech, STT, LLM streaming, and TTS events...",
    },
  ]);
  const [categoryFilter, setCategoryFilter] = useState<LogCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever new logs arrive if autoScroll is enabled
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const addLog = (category: LogEntry["category"], title: string, content: string) => {
    const newEntry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      }),
      category,
      title,
      content,
    };
    setLogs((prev) => [...prev.slice(-300), newEntry]); // Retain last 300 entries in memory
  };

  useEffect(() => {
    // 1. Structured backend activity logs
    const unlistenActivity = listenEvent<LogEntry>("activity:log", (entry) => {
      if (entry && entry.content) {
        addLog(entry.category, entry.title, entry.content);
      }
    });

    // 2. Talk / Voice state transitions
    const unlistenTalkState = listenEvent<string>("talk:state", (state) => {
      const stateLabels: Record<string, string> = {
        listening: "Microphone Active (Listening for Speech)",
        transcribing: "Processing Recorded Audio Frames",
        thinking: "Context Bundling & Querying LLM",
        speaking: "Synthesizing Audio via TTS",
        idle: "Voice Standby",
      };
      addLog("talk", `Voice State: ${state.toUpperCase()}`, stateLabels[state] || state);
    });

    // 3. User Speech Transcriptions (STT)
    const unlistenTranscript = listenEvent<string>("talk:transcript", (text) => {
      if (text && text.trim()) {
        addLog("stt", "User Speech Transcribed", text.trim());
      }
    });

    // 4. LLM Streaming / Responses
    let lastReply = "";
    const unlistenBubble = listenEvent<string>("bubble_update", (reply) => {
      if (reply && reply.length > lastReply.length) {
        lastReply = reply;
      }
    });

    // 5. Dictation states
    const unlistenDictation = listenEvent<string>("dictation:state", (state) => {
      addLog("system", `Dictation Mode: ${state.toUpperCase()}`, `Dictation pipeline switched to ${state}`);
    });

    // 6. Pipeline Errors
    const unlistenError = listenEvent<{ stage: string; message: string }>("pipeline:error", (err) => {
      addLog("error", `${err.stage.toUpperCase()} Pipeline Error`, err.message);
    });

    return () => {
      unlistenActivity.then((fn) => fn && fn());
      unlistenTalkState.then((fn) => fn && fn());
      unlistenTranscript.then((fn) => fn && fn());
      unlistenBubble.then((fn) => fn && fn());
      unlistenDictation.then((fn) => fn && fn());
      unlistenError.then((fn) => fn && fn());
    };
  }, []);

  // Filter logs by category and search keyword
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const matchesCat = categoryFilter === "all" || log.category === categoryFilter;
      const q = searchQuery.toLowerCase().trim();
      const matchesQuery =
        !q ||
        log.title.toLowerCase().includes(q) ||
        log.content.toLowerCase().includes(q) ||
        log.category.toLowerCase().includes(q);
      return matchesCat && matchesQuery;
    });
  }, [logs, categoryFilter, searchQuery]);

  // Category counts
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: logs.length, talk: 0, stt: 0, llm: 0, tts: 0, overlay: 0, error: 0 };
    logs.forEach((l) => {
      if (c[l.category] !== undefined) c[l.category]++;
    });
    return c;
  }, [logs]);

  const handleCopyLogs = () => {
    const text = filteredLogs
      .map((l) => `[${l.timestamp}] [${l.category.toUpperCase()}] ${l.title}: ${l.content}`)
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Logs copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportLogs = () => {
    const text = JSON.stringify(logs, null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `heyclicky-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Logs exported as JSON");
  };

  const handleClear = () => {
    setLogs([]);
    toast.info("Logs cleared");
  };

  return (
    <div className="flex flex-col h-full space-y-4 outline-none">
      {/* Top Filter and Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {(["all", "talk", "stt", "llm", "tts", "overlay", "error"] as LogCategory[]).map((cat) => {
            const isSelected = categoryFilter === cat;
            return (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  isSelected
                    ? "bg-zinc-800 text-white font-medium shadow-sm border border-zinc-700"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
                }`}
              >
                <span className="capitalize">{cat === "all" ? "All Logs" : cat.toUpperCase()}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    isSelected ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800/60 text-zinc-500"
                  }`}
                >
                  {counts[cat] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              placeholder="Search activity..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-44 pl-8 pr-3 py-1 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
            />
          </div>

          {/* Auto-scroll Toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoScroll(!autoScroll)}
            className={`h-7 px-2 text-xs gap-1 ${autoScroll ? "text-sky-400" : "text-zinc-500"}`}
            title={autoScroll ? "Auto-scroll ON (click to pause)" : "Auto-scroll PAUSED (click to enable)"}
          >
            {autoScroll ? <PlayCircle className="w-3.5 h-3.5" /> : <PauseCircle className="w-3.5 h-3.5" />}
            <span>{autoScroll ? "Live" : "Paused"}</span>
          </Button>

          {/* Copy Button */}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCopyLogs}
            disabled={filteredLogs.length === 0}
            className="h-7 px-2.5 text-xs gap-1.5"
            title="Copy filtered logs to clipboard"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>Copy</span>
          </Button>

          {/* Export JSON Button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExportLogs}
            disabled={logs.length === 0}
            className="h-7 px-2 text-xs"
            title="Export full log history as JSON"
          >
            <Download className="w-3.5 h-3.5" />
          </Button>

          {/* Clear Logs Button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={logs.length === 0}
            className="h-7 px-2 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
            title="Clear current log history"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Main Log Stream Console */}
      <Card className="flex-1 min-h-[460px] max-h-[560px] bg-zinc-950/90 border border-zinc-800/80 rounded-xl overflow-hidden flex flex-col font-mono text-xs">
        {/* Terminal Header */}
        <div className="h-8 bg-zinc-900/80 border-b border-zinc-800 px-3 flex items-center justify-between text-[11px] text-zinc-400">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-semibold text-zinc-300">REALTIME PIPELINE STREAM</span>
            <span className="text-zinc-600">|</span>
            <span>{filteredLogs.length} events logged</span>
          </div>
          <span className="text-[10px] text-zinc-500">Auto-refresh active</span>
        </div>

        {/* Scrollable Event Feed */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 select-text">
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-1.5 py-12">
              <Terminal className="w-8 h-8 opacity-40" />
              <p className="text-xs">No activity logs recorded matching criteria.</p>
              <p className="text-[10px] text-zinc-600">Speak or trigger Talk mode to generate real-time events.</p>
            </div>
          ) : (
            filteredLogs.map((log) => {
              const meta = CATEGORY_STYLES[log.category] || CATEGORY_STYLES.system;
              return (
                <div
                  key={log.id}
                  className="flex items-start gap-2.5 p-2 rounded-lg bg-zinc-900/40 hover:bg-zinc-900/80 border border-zinc-800/50 transition-colors"
                >
                  {/* Timestamp */}
                  <span className="text-[10px] text-zinc-500 shrink-0 pt-0.5">{log.timestamp}</span>

                  {/* Category Pill */}
                  <div
                    className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider ${meta.badgeClass}`}
                  >
                    {meta.icon}
                    <span>{meta.label}</span>
                  </div>

                  {/* Log Content Body */}
                  <div className="flex-1 min-w-0">
                    <p className="text-zinc-300 font-semibold text-[11px] leading-tight">{log.title}</p>
                    <p className="text-zinc-400 text-xs mt-1 whitespace-pre-wrap break-words leading-relaxed font-sans">
                      {log.content}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>
    </div>
  );
};
