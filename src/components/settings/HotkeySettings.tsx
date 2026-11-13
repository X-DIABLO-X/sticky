import React, { useState } from "react";
import type { AppHotkeys } from "../../types/models";
import { Keyboard, RotateCcw, Check, Sparkles } from "lucide-react";

interface HotkeySettingsProps {
  hotkeys: AppHotkeys;
  onSaveHotkeys: (updated: AppHotkeys) => void;
}

export const HotkeySettings: React.FC<HotkeySettingsProps> = ({ hotkeys, onSaveHotkeys }) => {
  const [currentHotkeys, setCurrentHotkeys] = useState<AppHotkeys>(hotkeys);
  const [recordingField, setRecordingField] = useState<keyof AppHotkeys | null>(null);

  const defaultHotkeys: AppHotkeys = {
    talk: "Ctrl+Space",
    dictation: "Ctrl+Shift+D",
    pill: "Ctrl+Alt+C",
    quickInput: "Double-Ctrl",
    abortDrive: "Escape",
  };

  const handleKeyDown = (e: React.KeyboardEvent, field: keyof AppHotkeys) => {
    e.preventDefault();
    if (e.key === "Tab") return;

    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");

    const key = e.key.toUpperCase();
    if (!["CONTROL", "ALT", "SHIFT", "META"].includes(key)) {
      parts.push(key === " " ? "Space" : key);
      const combo = parts.join("+");
      const updated = { ...currentHotkeys, [field]: combo };
      setCurrentHotkeys(updated);
      onSaveHotkeys(updated);
      setRecordingField(null);
    }
  };

  const handleResetDefaults = () => {
    setCurrentHotkeys(defaultHotkeys);
    onSaveHotkeys(defaultHotkeys);
  };

  const fields: Array<{ key: keyof AppHotkeys; label: string; description: string }> = [
    {
      key: "talk",
      label: "Push-to-Talk (Conversational Mode)",
      description: "Hold or toggle to speak directly to active Clicky with instant voice playback.",
    },
    {
      key: "dictation",
      label: "Active-Caret Dictation",
      description: "Dictates directly into active text box with 20s self-learning dictionary hook.",
    },
    {
      key: "quickInput",
      label: "Quick Input Spotlight",
      description: "Summons the sleek spotlight search prompt and multi-modal file drop bar.",
    },
    {
      key: "pill",
      label: "Toggle Top Pill Window",
      description: "Expand or collapse the top status notch and agent drawer.",
    },
    {
      key: "abortDrive",
      label: "Emergency Abort (Drive Mode)",
      description: "Instantly halt any mouse/keyboard desktop automation in progress.",
    },
  ];

  return (
    <div className="flex flex-col h-full overflow-y-auto space-y-4 p-1 pr-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Global Shortcuts
        </span>
        <button
          onClick={handleResetDefaults}
          className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          <span>Reset Defaults</span>
        </button>
      </div>

      <div className="space-y-3">
        {fields.map((f) => {
          const isRecording = recordingField === f.key;
          const value = currentHotkeys[f.key];

          return (
            <div
              key={f.key}
              className="p-3 rounded-xl bg-slate-800/40 border border-white/5 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="text-xs font-semibold text-slate-200">{f.label}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{f.description}</div>
                </div>

                <button
                  type="button"
                  onClick={() => setRecordingField(isRecording ? null : f.key)}
                  onKeyDown={(e) => isRecording && handleKeyDown(e, f.key)}
                  className={`px-3 py-1.5 rounded-lg font-mono text-xs font-bold transition-all border shrink-0 ${
                    isRecording
                      ? "bg-amber-500/20 text-amber-300 border-amber-400 animate-pulse"
                      : "bg-black/50 text-sky-400 border-white/10 hover:border-sky-400/50"
                  }`}
                >
                  {isRecording ? "Press keys..." : value}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-3 rounded-xl bg-sky-500/10 border border-sky-400/20 text-xs text-sky-300/90 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-sky-400 shrink-0" />
        <span>
          Hotkeys are registered at the OS level via <code>tauri-plugin-global-shortcut</code> and work across all apps.
        </span>
      </div>
    </div>
  );
};
