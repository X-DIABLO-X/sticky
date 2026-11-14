import React, { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Loader2, X } from "lucide-react";
import { invokeCommand, listenEvent } from "../lib/ipc";

export const QuickInputWindow: React.FC = () => {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const closeAndReset = async () => {
    setText("");
    setError(null);
    await invokeCommand("hide_quick_input").catch(() => {});
  };

  useEffect(() => {
    inputRef.current?.focus();

    const unlistenFocus = listenEvent("quick_input_focus", () => {
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 20);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAndReset();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unlistenFocus.then((fn) => fn && fn());
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await invokeCommand<string>("execute_prompt", { prompt });
      await closeAndReset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to execute prompt");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full h-full p-2 flex flex-col justify-center select-none">
      <form
        onSubmit={handleSubmit}
        className="floating-pill rounded-xl px-3.5 py-2.5 flex items-center gap-2.5"
      >
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask Sticky about your screen or run a command..."
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
        />
        <span className="kbd-cap">Esc</span>
        <button
          type="submit"
          disabled={submitting || !text.trim()}
          className="p-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <CornerDownLeft className="w-4 h-4" />
          )}
        </button>
      </form>

      {error && (
        <div className="mt-1 px-3 py-1 rounded-md bg-red-950/90 border border-red-500/40 text-xs text-red-200 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-white">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
};
