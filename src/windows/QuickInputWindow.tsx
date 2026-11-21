import React, { useEffect, useState } from "react";
import { Command } from "cmdk";
import { motion } from "framer-motion";
import { CornerDownLeft, LayoutDashboard, Loader2, Mic, Search, Sparkles } from "lucide-react";
import { invokeCommand, listenEvent } from "../lib/ipc";

export const QuickInputWindow: React.FC = () => {
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closePalette = async () => {
    setQuery("");
    setError(null);
    await invokeCommand("hide_quick_input").catch(() => {});
  };

  useEffect(() => {
    const unlisten = listenEvent("quick_input_focus", () => {
      setError(null);
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unlisten.then((fn) => fn && fn());
    };
  }, []);

  const runPrompt = async (promptText: string) => {
    const cleaned = promptText.trim();
    if (!cleaned || running) return;
    setRunning(true);
    setError(null);
    try {
      await invokeCommand<string>("execute_prompt", { prompt: cleaned });
      await closePalette();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Prompt execution failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.14 }}
      className="w-full h-full p-2 select-none"
    >
      <Command label="Sticky Command Palette" shouldFilter={true}>
        <div className="flex items-center gap-2.5 border-b border-white/[0.08] px-3.5 py-2.5">
          {running ? (
            <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
          ) : (
            <Search className="w-4 h-4 text-zinc-500" />
          )}
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) {
                e.preventDefault();
                runPrompt(query);
              }
            }}
            placeholder="Ask Sticky about your screen or pick an action..."
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
          />
          <span className="kbd-cap">Esc</span>
        </div>

        <Command.List className="max-h-56 overflow-y-auto p-2 space-y-1">
          {query.trim() && (
            <Command.Group heading="Ask AI">
              <Command.Item onSelect={() => runPrompt(query)}>
                <span className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                  Send &ldquo;{query.slice(0, 48)}&rdquo;
                </span>
                <CornerDownLeft className="w-3.5 h-3.5 text-zinc-500" />
              </Command.Item>
            </Command.Group>
          )}

          <Command.Group heading="Quick Actions">
            <Command.Item
              onSelect={async () => {
                await invokeCommand("start_talk").catch(() => {});
                await closePalette();
              }}
            >
              <span className="flex items-center gap-2">
                <Mic className="w-3.5 h-3.5 text-emerald-400" />
                Start Voice Talk Mode
              </span>
              <span className="kbd-cap">Ctrl+Shift+Space</span>
            </Command.Item>

            <Command.Item
              onSelect={async () => {
                await invokeCommand("open_dashboard").catch(() => {});
                await closePalette();
              }}
            >
              <span className="flex items-center gap-2">
                <LayoutDashboard className="w-3.5 h-3.5 text-zinc-400" />
                Open Control Center
              </span>
            </Command.Item>
          </Command.Group>
        </Command.List>

        {error && (
          <div className="border-t border-red-500/30 bg-red-500/10 px-3.5 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </Command>
    </motion.div>
  );
};
