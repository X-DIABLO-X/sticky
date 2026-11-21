import React, { useEffect, useRef, useState } from "react";
import { listenEvent } from "../../lib/ipc";
import { interpolate2D, type Point2D } from "../../lib/bezier";
import type { OverlayPointEvent } from "../../types/events";

interface CursorPosPayload {
  x: number;
  y: number;
  clicking?: boolean;
}

interface CursorFollowerProps {
  enabled?: boolean;
  talkActive?: boolean;
  dictationActive?: boolean;
  aiTarget?: OverlayPointEvent | null;
  onClearTarget?: () => void;
  guidedMode?: boolean;
}

/**
 * Unified HeyClicky-style Emerald Cursor Companion:
 * ONE single rounded emerald-green triangular pointer on screen at all times.
 *
 * Mode A (Following User — aiTarget == null):
 *   Smoothly trails the OS mouse cursor offset below-right (+24px, +16px),
 *   with subtle directional tilt, soft emerald radial glow, and listening pulse.
 *
 * Mode B (AI Pointing — aiTarget != null):
 *   That exact same emerald triangle glides along a cubic Bezier arc to the
 *   target coordinate, rotates so its pointed tip touches the exact target,
 *   displays an arrival emerald ripple ring + compact dark-glass label pill,
 *   and glides smoothly back to the user's cursor when cleared.
 */
export const CursorFollower: React.FC<CursorFollowerProps> = ({
  enabled = true,
  talkActive = false,
  dictationActive = false,
  aiTarget = null,
  onClearTarget,
  guidedMode = false,
}) => {
  const [isClicking, setIsClicking] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [pillFlip, setPillFlip] = useState<{ left: boolean; top: boolean }>({
    left: false,
    top: false,
  });

  // Real OS cursor position (logical viewport pixels)
  const userPosRef = useRef<Point2D>({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });

  // Current rendered position of the single emerald cursor anchor
  const currentPosRef = useRef<Point2D>({
    x: window.innerWidth / 2 + 24,
    y: window.innerHeight / 2 + 16,
  });

  // Current rotation angle (degrees) and tip-alignment offset
  const angleRef = useRef(-8);
  const tipShiftRef = useRef<Point2D>({ x: 0, y: 0 });

  // Active Bezier glide state when moving to an AI target
  const glideRef = useRef<{
    active: boolean;
    start: Point2D;
    end: Point2D;
    startTime: number;
    durationMs: number;
    completed: boolean;
  }>({
    active: false,
    start: { x: 0, y: 0 },
    end: { x: 0, y: 0 },
    startTime: 0,
    durationMs: 460,
    completed: false,
  });

  const aiTargetRef = useRef<OverlayPointEvent | null>(aiTarget);
  aiTargetRef.current = aiTarget;

  const isClickingRef = useRef(isClicking);
  isClickingRef.current = isClicking;

  const talkActiveRef = useRef(talkActive);
  talkActiveRef.current = talkActive;

  const outerRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);

  // Track OS cursor via Tauri event + local mousemove fallback
  useEffect(() => {
    const unlisten = listenEvent<CursorPosPayload>("cursor_pos", (data) => {
      const dpr = window.devicePixelRatio || 1;
      userPosRef.current.x = data.x / dpr;
      userPosRef.current.y = data.y / dpr;
      if (data.clicking !== undefined) {
        setIsClicking(data.clicking);
      }
    });

    const handleLocalMove = (e: MouseEvent) => {
      userPosRef.current.x = e.clientX;
      userPosRef.current.y = e.clientY;
    };
    const handleMouseDown = () => setIsClicking(true);
    const handleMouseUp = () => setIsClicking(false);

    window.addEventListener("mousemove", handleLocalMove, { passive: true });
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      unlisten.then((u) => u());
      window.removeEventListener("mousemove", handleLocalMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Configure Bezier glide + Escape / 12s auto-return whenever aiTarget changes
  useEffect(() => {
    if (!aiTarget) {
      glideRef.current.active = false;
      glideRef.current.completed = false;
      setArrived(false);
      return;
    }

    const targetX = (aiTarget.x / 1000) * window.innerWidth;
    const targetY = (aiTarget.y / 1000) * window.innerHeight;

    setArrived(false);
    setPillFlip({
      left: targetX > window.innerWidth - 220,
      top: targetY > window.innerHeight - 72,
    });

    const rawDuration = aiTarget.durationMs ?? 460;
    const glideDuration = Math.max(300, Math.min(720, rawDuration));

    glideRef.current = {
      active: true,
      start: { ...currentPosRef.current },
      end: { x: targetX, y: targetY },
      startTime: performance.now(),
      durationMs: glideDuration,
      completed: false,
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClearTarget?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    // 12-second auto-return when not in guided walkthrough mode
    let autoReturnTimer: number | undefined;
    if (!guidedMode) {
      autoReturnTimer = window.setTimeout(() => {
        onClearTarget?.();
      }, 12000);
    }

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (autoReturnTimer !== undefined) {
        window.clearTimeout(autoReturnTimer);
      }
    };
  }, [aiTarget, guidedMode, onClearTarget]);

  // Unified 60fps animation loop for both Mode A (user follow) and Mode B (AI pointing)
  useEffect(() => {
    if (!enabled) return;
    let animId: number;

    const animate = (now: number) => {
      const current = currentPosRef.current;
      const targetActive = aiTargetRef.current !== null;

      if (targetActive && glideRef.current.active) {
        // Mode B: Cubic Bezier arc glide to exact AI target coordinate
        const g = glideRef.current;
        const elapsed = now - g.startTime;
        const progress = Math.min(elapsed / g.durationMs, 1.0);

        const pos = interpolate2D(g.start, g.end, progress, 0.08);
        current.x = pos.x;
        current.y = pos.y;

        // Rotate smoothly so the triangle tip points up-left (-135 deg) directly onto the target
        const desiredAngle = -135;
        angleRef.current += (desiredAngle - angleRef.current) * 0.2;

        // Offset inner triangle by (+5, +5) so its tip touches (0, 0) = exact target coordinate
        tipShiftRef.current.x += (5 - tipShiftRef.current.x) * 0.22;
        tipShiftRef.current.y += (5 - tipShiftRef.current.y) * 0.22;

        if (progress >= 1.0 && !g.completed) {
          g.completed = true;
          setArrived(true);
        }
      } else {
        // Mode A: Smooth spring trail behind user's real OS cursor (+24px, +16px)
        const desiredX = userPosRef.current.x + 24;
        const desiredY = userPosRef.current.y + 16;

        const dx = desiredX - current.x;
        const dy = desiredY - current.y;
        current.x += dx * 0.22;
        current.y += dy * 0.22;

        const speed = Math.hypot(dx, dy);
        const desiredAngle =
          speed > 2.5 ? Math.max(-28, Math.min(28, dy * 0.45 - 8)) : -8;
        angleRef.current += (desiredAngle - angleRef.current) * 0.16;

        tipShiftRef.current.x += (0 - tipShiftRef.current.x) * 0.18;
        tipShiftRef.current.y += (0 - tipShiftRef.current.y) * 0.18;
      }

      if (outerRef.current) {
        outerRef.current.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`;
      }

      if (pointerRef.current) {
        const scale = targetActive
          ? 1.08
          : isClickingRef.current
          ? 0.86
          : talkActiveRef.current
          ? 1.12
          : 1.0;

        pointerRef.current.style.transform = `translate3d(${tipShiftRef.current.x}px, ${tipShiftRef.current.y}px, 0) rotate(${angleRef.current}deg) scale(${scale})`;
      }

      animId = requestAnimationFrame(animate);
    };

    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, [enabled]);

  if (!enabled) return null;

  const isPointing = aiTarget !== null;
  const fillMain = isPointing
    ? "#00a35f"
    : dictationActive
    ? "#d97706"
    : talkActive
    ? "#059669"
    : "#008f53";

  const glowColor = isPointing
    ? "rgba(16, 185, 129, 0.58)"
    : dictationActive
    ? "rgba(245, 158, 11, 0.42)"
    : talkActive
    ? "rgba(16, 185, 129, 0.55)"
    : "rgba(16, 185, 129, 0.36)";

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden">
      {/* Anchor positioned at (current.x, current.y) */}
      <div
        ref={outerRef}
        className="absolute top-0 left-0 w-0 h-0 pointer-events-none will-change-transform"
      >
        {/* Arrival emerald ripple ring centered directly on exact target coordinate */}
        {isPointing && arrived && (
          <>
            <div className="absolute -left-6 -top-6 w-12 h-12 rounded-full border border-emerald-400/80 animate-ping opacity-75 pointer-events-none" />
            <div className="absolute -left-2 -top-2 w-4 h-4 rounded-full border border-emerald-300/70 bg-emerald-400/20 pointer-events-none" />
          </>
        )}

        {/* Single HeyClicky Emerald Triangle + Glow Halo */}
        <div
          ref={pointerRef}
          className="absolute -left-5 -top-5 w-10 h-10 flex items-center justify-center pointer-events-none will-change-transform"
        >
          {/* Soft diffused emerald ambient glow halo */}
          <div
            className={`absolute inset-0 rounded-full blur-[9px] transition-all duration-200 ${
              talkActive || isPointing ? "scale-125 animate-pulse" : "scale-100"
            }`}
            style={{
              background: `radial-gradient(circle, ${glowColor} 0%, rgba(16, 185, 129, 0) 72%)`,
            }}
          />

          {/* Listening / Dictation ping ring (Mode A only) */}
          {!isPointing && (talkActive || dictationActive) && (
            <div
              className={`absolute inset-1 rounded-full animate-ping opacity-60 ${
                dictationActive ? "bg-amber-400/35" : "bg-emerald-400/35"
              }`}
            />
          )}

          {/* Crisp Rounded Emerald Triangle Pointer */}
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{
              filter: `drop-shadow(0 0 7px ${glowColor})`,
            }}
          >
            <path
              d="M5.2 3.8C4.1 3.15 2.75 3.95 2.75 5.22V18.78C2.75 20.05 4.1 20.85 5.2 20.2L19.4 13.42C20.52 12.88 20.52 11.12 19.4 10.58L5.2 3.8Z"
              fill={fillMain}
            />
          </svg>

          {/* Subtle click feedback ripple (Mode A only) */}
          {!isPointing && isClicking && (
            <div className="absolute w-9 h-9 rounded-full border border-emerald-400/70 animate-ping pointer-events-none" />
          )}
        </div>

        {/* Clean compact dark-glass label pill on AI target (never shows noisy Screen 0 text) */}
        {isPointing && aiTarget?.label && (
          <div
            className={`absolute pointer-events-none select-none flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-950/90 border border-emerald-400/50 shadow-[0_4px_20px_rgba(0,0,0,0.6)] backdrop-blur-md text-xs font-medium text-zinc-100 whitespace-nowrap transition-opacity duration-200 ${
              arrived ? "opacity-100" : "opacity-80"
            } ${pillFlip.left ? "right-5" : "left-5"} ${
              pillFlip.top ? "bottom-5" : "top-4"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span>{aiTarget.label}</span>
          </div>
        )}
      </div>
    </div>
  );
};
