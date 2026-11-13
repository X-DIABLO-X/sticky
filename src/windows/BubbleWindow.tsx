import React, { useEffect, useRef, useState } from "react";
import { listenEvent } from "../lib/ipc";
import type { TranscriptEvent } from "../types/events";
import { Mic, Radio, Volume2 } from "lucide-react";

export const BubbleWindow: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [caption, setCaption] = useState<string>("Listening...");
  const [speaker, setSpeaker] = useState<"user" | "clicky" | "system">("user");
  const [isActive, setIsActive] = useState<boolean>(true);
  const audioLevelsRef = useRef<number[]>(new Array(24).fill(4));

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

      // Simulate or update dynamic sound waves
      const levels = audioLevelsRef.current;
      for (let i = 0; i < numBars; i++) {
        if (isActive) {
          // Dynamic undulating voice frequency bars
          const target = Math.random() * 20 + 3;
          levels[i] += (target - levels[i]) * 0.25;
        } else {
          levels[i] += (2 - levels[i]) * 0.1;
        }

        const h = levels[i];
        const x = startX + i * (barWidth + gap);

        const gradient = ctx.createLinearGradient(0, centerY - h, 0, centerY + h);
        if (speaker === "clicky") {
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
  }, [isActive, speaker]);

  // Listen for real-time transcript streaming events
  useEffect(() => {
    const unlistenTranscript = listenEvent<TranscriptEvent>("transcript_chunk", (ev) => {
      setCaption(ev.text);
      setSpeaker(ev.speaker);
      setIsActive(ev.audioActive ?? true);
    });

    const unlistenAudioBytes = listenEvent<ArrayBuffer>("audio_waveform_bytes", (buffer) => {
      // If raw PCM waveform is streamed over binary channel, compute amplitude
      const view = new Uint8Array(buffer);
      if (view.length > 0) {
        let sum = 0;
        for (let i = 0; i < Math.min(view.length, 64); i++) {
          sum += Math.abs(view[i] - 128);
        }
        const avg = sum / 64;
        audioLevelsRef.current = audioLevelsRef.current.map(() => Math.min(26, 4 + avg * 0.5));
      }
    });

    const unlistenAmplitude = listenEvent<number>("audio_amplitude", (rms) => {
      const scaled = Math.min(26, Math.max(4, rms * 350));
      audioLevelsRef.current = audioLevelsRef.current.map(() => Math.max(3, scaled + (Math.random() * 6 - 3)));
    });

    return () => {
      unlistenTranscript.then((un) => un());
      unlistenAudioBytes.then((un) => un());
      unlistenAmplitude.then((un) => un());
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
