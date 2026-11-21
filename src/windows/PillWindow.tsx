import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { LayoutDashboard, Mic, Square } from "lucide-react";
import { invokeCommand, listenEvent } from "../lib/ipc";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/primitives";

type TalkState = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

export const PillWindow: React.FC = () => {
  const [state, setState] = useState<TalkState>("idle");
  const [rms, setRms] = useState(0);

  useEffect(() => {
    const u1 = listenEvent<string>("talk:state", (s) => setState(s as TalkState));
    const u2 = listenEvent<number>("audio:rms", (v) => setRms(Math.min(1, v * 8)));
    return () => {
      u1.then((fn) => fn && fn());
      u2.then((fn) => fn && fn());
    };
  }, []);

  const isListening = state === "listening";
  const statusColor =
    state === "listening"
      ? "bg-emerald-400"
      : state === "thinking" || state === "transcribing"
      ? "bg-amber-400"
      : state === "speaking"
      ? "bg-blue-400"
      : "bg-zinc-500";

  const handleToggleTalk = async () => {
    if (isListening) {
      await invokeCommand("stop_talk").catch(() => {});
    } else {
      await invokeCommand("start_talk").catch(() => {});
    }
  };

  return (
    <TooltipProvider>
      <div className="w-full h-full flex items-center justify-center p-1 select-none">
        <motion.div
          layout
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          className="floating-pill h-10 px-3 rounded-full flex items-center gap-2.5 text-xs text-zinc-200"
        >
          <span className={`w-2 h-2 rounded-full ${statusColor}`} />
          <span className="font-medium capitalize tracking-tight min-w-[74px]">
            {state === "idle" ? "Sticky Ready" : state}
          </span>

          {isListening && (
            <div className="flex items-center gap-0.5 h-4">
              {[0.5, 0.9, 1.0, 0.7, 0.4].map((scale, i) => (
                <motion.span
                  key={i}
                  animate={{ height: Math.max(4, Math.round(rms * 16 * scale)) }}
                  transition={{ duration: 0.06 }}
                  className="w-0.5 rounded-full bg-emerald-400"
                />
              ))}
            </div>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleToggleTalk}
                className={`p-1.5 rounded-full transition-colors ${
                  isListening
                    ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                    : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                }`}
              >
                {isListening ? <Square className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{isListening ? "Stop Listening" : "Start Voice Talk"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => invokeCommand("open_dashboard").catch(() => {})}
                className="p-1.5 rounded-full bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              >
                <LayoutDashboard className="w-3 h-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Open Control Center</TooltipContent>
          </Tooltip>
        </motion.div>
      </div>
    </TooltipProvider>
  );
};
