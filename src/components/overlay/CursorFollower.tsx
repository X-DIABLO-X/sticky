import React, { useEffect, useRef, useState } from "react";
import { listenEvent } from "../../lib/ipc";

interface CursorPosPayload {
  x: number;
  y: number;
  clicking?: boolean;
}

interface CursorFollowerProps {
  enabled?: boolean;
  talkActive?: boolean;
  dictationActive?: boolean;
}

export const CursorFollower: React.FC<CursorFollowerProps> = ({
  enabled = true,
  talkActive = false,
  dictationActive = false,
}) => {
  const [visible, setVisible] = useState(enabled);
  const [isBlinking, setIsBlinking] = useState(false);
  const [isClicking, setIsClicking] = useState(false);

  // Position refs for 60fps lerp
  const targetPos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const currentPos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const trailPos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const velocity = useRef({ x: 0, y: 0, speed: 0 });

  const followerRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);

  // 1. Listen for 60Hz OS-wide cursor broadcast from Rust backend
  useEffect(() => {
    const unlisten = listenEvent<CursorPosPayload>("cursor_pos", (data) => {
      const dpr = window.devicePixelRatio || 1;
      targetPos.current.x = data.x / dpr;
      targetPos.current.y = data.y / dpr;
      if (data.clicking !== undefined) {
        setIsClicking(data.clicking);
      }
    });

    // Also listen to local mousemove as instant backup
    const handleLocalMove = (e: MouseEvent) => {
      targetPos.current.x = e.clientX;
      targetPos.current.y = e.clientY;
    };
    const handleMouseDown = () => setIsClicking(true);
    const handleMouseUp = () => setIsClicking(false);

    window.addEventListener("mousemove", handleLocalMove, { passive: true });
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);

    // Natural random blinking interval
    const blinkInterval = setInterval(() => {
      setIsBlinking(true);
      setTimeout(() => setIsBlinking(false), 140);
    }, 3800);

    return () => {
      unlisten.then((u) => u());
      window.removeEventListener("mousemove", handleLocalMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
      clearInterval(blinkInterval);
    };
  }, []);

  // 2. Physics animation loop using requestAnimationFrame
  useEffect(() => {
    if (!visible) return;

    let animId: number;

    const animate = () => {
      const target = targetPos.current;
      const current = currentPos.current;
      const trail = trailPos.current;

      // Spring lerp for main follower (0.22)
      const dx = target.x - current.x;
      const dy = target.y - current.y;
      current.x += dx * 0.22;
      current.y += dy * 0.22;

      // Slower lerp for fluid ghost trail (0.12)
      trail.x += (current.x - trail.x) * 0.12;
      trail.y += (current.y - trail.y) * 0.12;

      // Calculate instantaneous velocity
      velocity.current.x = dx;
      velocity.current.y = dy;
      velocity.current.speed = Math.sqrt(dx * dx + dy * dy);

      // Apply transform to DOM elements directly for max performance
      if (followerRef.current) {
        // Place companion ~20px offset to the bottom-right of cursor pointer
        const posX = current.x + 18;
        const posY = current.y + 16;

        // Subtle tilt based on movement direction
        const tilt = Math.max(Math.min(dx * 0.35, 25), -25);
        const squash = Math.min(velocity.current.speed * 0.002, 0.15);

        followerRef.current.style.transform = `translate3d(${posX}px, ${posY}px, 0) rotate(${tilt}deg) scale(${
          isClicking ? 0.85 : 1.0 + squash
        }, ${isClicking ? 0.85 : 1.0 - squash})`;
      }

      if (trailRef.current) {
        const trailX = trail.x + 18;
        const trailY = trail.y + 16;
        trailRef.current.style.transform = `translate3d(${trailX}px, ${trailY}px, 0)`;
      }

      animId = requestAnimationFrame(animate);
    };

    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, [visible, isClicking]);

  if (!visible) return null;

  // Eye gaze follows velocity
  const eyeDx = Math.max(Math.min(velocity.current.x * 0.08, 2.5), -2.5);
  const eyeDy = Math.max(Math.min(velocity.current.y * 0.08, 2), -2);

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden">
      {/* Ghost Trail Particle */}
      <div
        ref={trailRef}
        className="absolute top-0 left-0 w-6 h-6 rounded-full -ml-3 -mt-3 bg-sky-400/20 blur-[3px] transition-opacity duration-300 pointer-events-none"
      />

      {/* Main Clicky Cursor Companion */}
      <div
        ref={followerRef}
        className="absolute top-0 left-0 -ml-3.5 -mt-3.5 flex items-center justify-center pointer-events-none will-change-transform"
      >
        {/* Active Audio Wave Aura (When talking/listening) */}
        {(talkActive || dictationActive) && (
          <div
            className={`absolute -inset-2.5 rounded-full animate-ping opacity-75 ${
              talkActive ? "bg-cyan-400/40" : "bg-amber-400/40"
            }`}
          />
        )}

        {/* Ambient Outer Glow Halo */}
        <div
          className={`relative flex items-center justify-center w-8 h-8 rounded-full shadow-lg transition-colors duration-200 ${
            talkActive
              ? "bg-gradient-to-tr from-cyan-400 via-sky-500 to-indigo-500 shadow-cyan-400/60"
              : dictationActive
              ? "bg-gradient-to-tr from-amber-400 via-orange-500 to-rose-500 shadow-amber-400/60"
              : "bg-gradient-to-tr from-sky-400 via-indigo-500 to-cyan-300 shadow-sky-400/50"
          }`}
          style={{
            boxShadow: talkActive
              ? "0 0 20px rgba(34, 211, 238, 0.85)"
              : dictationActive
              ? "0 0 20px rgba(245, 158, 11, 0.85)"
              : "0 0 16px rgba(56, 189, 248, 0.75)",
          }}
        >
          {/* Inner Cute Clicky Face */}
          <div className="relative flex items-center justify-center w-6 h-6 rounded-full bg-slate-950/85">
            {/* Eyes Container */}
            <div
              className="flex items-center gap-1.5 transition-transform duration-75"
              style={{ transform: `translate(${eyeDx}px, ${eyeDy}px)` }}
            >
              {/* Left Eye */}
              <div
                className={`w-1.5 h-2 rounded-full transition-all duration-75 ${
                  isBlinking
                    ? "h-0.5 bg-sky-300 scale-y-10"
                    : "bg-sky-200 shadow-sm shadow-sky-300"
                }`}
              />

              {/* Right Eye */}
              <div
                className={`w-1.5 h-2 rounded-full transition-all duration-75 ${
                  isBlinking
                    ? "h-0.5 bg-sky-300 scale-y-10"
                    : "bg-sky-200 shadow-sm shadow-sky-300"
                }`}
              />
            </div>

            {/* Sparkle Ear Antennas */}
            <div className="absolute -top-1 -right-0.5 w-2 h-2 rounded-full bg-cyan-300 animate-pulse shadow-sm shadow-cyan-300" />
          </div>
        </div>

        {/* Click Feedback Ripple */}
        {isClicking && (
          <div className="absolute w-12 h-12 rounded-full border border-sky-400/70 animate-ping pointer-events-none" />
        )}
      </div>
    </div>
  );
};
