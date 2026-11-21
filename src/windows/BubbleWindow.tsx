import React, { useEffect, useRef, useState } from "react";
import { listenEvent } from "../lib/ipc";
import type { TranscriptEvent } from "../types/events";
import { Mic, Radio, Volume2 } from "lucide-react";

export const BubbleWindow: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [caption, setCaption] = useState<string>("Listening...");
  const [speaker, setSpeaker] = useState<"user" | "clicky" | "system">("user");
  const [talkState, setTalkState] = useState<string>("listening");
  const [isActive, setIsActive] = useState<boolean>(true);
  const audioLevelsRef = useRef<number[]>(new Array(24).fill(3));
  const latestRmsRef = useRef<number>(0);

  // Audio waveform animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;

    const renderWave = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const numBars = 22;
      const barWidth = 3;
      const gap = 2;
      const totalWidth = numBars * (barWidth + gap);
      const startX = (canvas.width - totalWidth) / 2;
      const centerY = canvas.height / 2;

      const levels = audioLevelsRef.current;
      const now = performance.now() / 180;
      for (let i = 0; i < numBars; i++) {
        let target = 2.5;
        if (talkState === "listening") {
          const rmsAmp = Math.min(20, latestRmsRef.current * 450);
          const waveShape = 0.5 + 0.5 * Math.sin(now + i * 0.55);
          target = Math.max(3, 3 + rmsAmp * waveShape);
        } else if (talkState === "transcribing" || talkState === "thinking") {
          target = 4 + 5 * (0.5 + 0.5 * Math.sin(now * 1.4 - i * 0.35));
        } else if (talkState === "speaking") {
          target = 5 + 11 * (0.5 + 0.5 * Math.sin(now * 2.0 + i * 0.7));
        }
        levels[i] += (target - levels[i]) * 0.28;

        const h = levels[i];
        const x = startX + i * (barWidth + gap);

        const gradient = ctx.createLinearGradient(0, centerY - h, 0, centerY + h);
        if (talkState === "thinking" || talkState === "transcribing") {
          gradient.addColorStop(0, "#fbbf24");
          gradient.addColorStop(1, "#f59e0b");
        } else if (speaker === "clicky" || talkState === "speaking") {
          gradient.addColorStop(0, "#a855f7");
          gradient.addColorStop(1, "#38bdf8");
        } else {
          gradient.addColorStop(0, "#38bdf8");
          gradient.addColorStop(1, "#3b82f6");
        }

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x, centerY - h / 2, barWidth, h, 2);
        ctx.fill();
      }

      animId = requestAnimationFrame(renderWave);
    };

    animId = requestAnimationFrame(renderWave);
    return () => cancelAnimationFrame(animId);
  }, [isActive, speaker, talkState]);

  // Listen for real-time pipeline and transcript events
  useEffect(() => {
    const unlistenState = listenEvent<string>("talk:state", (st) => {
      setTalkState(st);
      if (st === "listening") {
        setSpeaker("user");
        setCaption("Listening...");
        setIsActive(true);
      } else if (st === "transcribing") {
        setSpeaker("system");
        setCaption("Transcribing...");
        setIsActive(true);
      } else if (st === "thinking") {
        setSpeaker("clicky");
        setCaption("Thinking...");
        setIsActive(true);
      } else if (st === "speaking") {
        setSpeaker("clicky");
        setIsActive(true);
      } else {
        setIsActive(false);
        latestRmsRef.current = 0;
      }
    });

    const unlistenTranscript = listenEvent<TranscriptEvent>("transcript_chunk", (ev) => {
      if (ev?.text) setCaption(ev.text);
      if (ev?.speaker) setSpeaker(ev.speaker);
      setIsActive(ev?.audioActive ?? true);
    });

    const unlistenTalkText = listenEvent<string>("talk:transcript", (text) => {
      if (text && text.trim()) {
        setSpeaker("user");
        setCaption(`"${text.trim()}"`);
      }
    });

    const unlistenBubbleUpdate = listenEvent<string>("bubble_update", (reply) => {
      if (reply && reply.trim()) {
        setSpeaker("clicky");
        setCaption(reply.trim());
      }
    });

    const unlistenAmplitude = listenEvent<number>("audio_amplitude", (rms) => {
      latestRmsRef.current = rms;
    });

    const unlistenRms = listenEvent<number>("audio:rms", (rms) => {
      latestRmsRef.current = rms;
    });

    return () => {
      unlistenState.then((un) => un());
      unlistenTranscript.then((un) => un());
      unlistenTalkText.then((un) => un());
      unlistenBubbleUpdate.then((un) => un());
      unlistenAmplitude.then((un) => un());
      unlistenRms.then((un) => un());
    };
  }, []);

  return (
    <div className="flex items-center justify-center w-full h-full p-2 select-none">
      {/* 260x64px Floating Cursor-Side Bubble */}
      <div className="relative w-[260px] h-[64px] rounded-2xl glass-pill flex items-center px-3.5 gap-3 border border-sky-400/40 shadow-2xl overflow-hidden animate-float">
        {/* Glowing Indicator Icon */}
        <div className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-slate-900/80 border border-white/10 shrink-0 shadow-inner">
          {speaker === "clicky" ? (
            <Volume2 className="w-4 h-4 text-purple-400" />
          ) : (
            <Mic className="w-4 h-4 text-sky-400" />
          )}
          {isActive && (
            <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500" />
            </span>
          )}
        </div>

        {/* Live Audio Waveform & Streaming Captions */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Waveform Canvas */}
          <div className="h-[22px] w-full flex items-center">
            <canvas ref={canvasRef} width={130} height={22} className="w-[130px] h-[22px]" />
          </div>

          {/* Streaming Caption text */}
          <div className="text-[11px] font-medium text-slate-200 truncate mt-0.5 tracking-tight">
            {caption}
          </div>
        </div>

        {/* Live status badge */}
        <div className="shrink-0">
          <Radio className="w-3.5 h-3.5 text-sky-400/80 animate-pulse" />
        </div>
      </div>
    </div>
  );
};
