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

/**
 * Authentic HeyClicky-style Cursor Companion:
 * Sleek rounded emerald-green triangular pointer with a soft diffused radial glow
 * that smoothly trails the OS cursor and rotates softly with movement.
 */
export const CursorFollower: React.FC<CursorFollowerProps> = ({
  enabled = true,
  talkActive = false,
  dictationActive = false,
}) => {
  const [visible] = useState(enabled);
  const [isClicking, setIsClicking] = useState(false);

  const targetPos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const currentPos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const angleRef = useRef(-10);

  const followerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = listenEvent<CursorPosPayload>("cursor_pos", (data) => {
      const dpr = window.devicePixelRatio || 1;
      targetPos.current.x = data.x / dpr;
      targetPos.current.y = data.y / dpr;
      if (data.clicking !== undefined) {
        setIsClicking(data.clicking);
      }
    });

    const handleLocalMove = (e: MouseEvent) => {
      targetPos.current.x = e.clientX;
      targetPos.current.y = e.clientY;
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

  useEffect(() => {
    if (!visible) return;
    let animId: number;

    const animate = () => {
      const target = targetPos.current;
      const current = currentPos.current;

      const dx = target.x - current.x;
      const dy = target.y - current.y;
      current.x += dx * 0.24;
      current.y += dy * 0.24;

      // Gently lean triangle angle toward motion, settling back to HeyClicky's signature slight tilt (-8 deg)
      const speed = Math.hypot(dx, dy);
      const desiredAngle = speed > 2.5 ? Math.max(-28, Math.min(28, dy * 0.45 - 8)) : -8;
      angleRef.current += (desiredAngle - angleRef.current) * 0.16;

      if (followerRef.current) {
        // Offset cleanly below-right of the native OS cursor arrow just like HeyClicky
        const posX = current.x + 26;
        const posY = current.y + 18;
        const scale = isClicking ? 0.86 : talkActive ? 1.12 : 1.0;

        followerRef.current.style.transform = `translate3d(${posX}px, ${posY}px, 0) rotate(${angleRef.current}deg) scale(${scale})`;
      }

      animId = requestAnimationFrame(animate);
    };

    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, [visible, isClicking, talkActive]);

  if (!visible) return null;

  const fillMain = dictationActive ? "#d97706" : talkActive ? "#059669" : "#008f53";
  const glowColor = dictationActive
    ? "rgba(245, 158, 11, 0.42)"
    : talkActive
    ? "rgba(16, 185, 129, 0.55)"
    : "rgba(16, 185, 129, 0.36)";

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden">
      <div
        ref={followerRef}
        className="absolute top-0 left-0 -ml-5 -mt-5 w-10 h-10 flex items-center justify-center pointer-events-none will-change-transform"
      >
        {/* Soft diffused emerald ambient glow halo (HeyClicky signature) */}
        <div
          className={`absolute inset-0 rounded-full blur-[9px] transition-all duration-200 ${
            talkActive ? "scale-125 animate-pulse" : "scale-100"
          }`}
          style={{
            background: `radial-gradient(circle, ${glowColor} 0%, rgba(16, 185, 129, 0) 72%)`,
          }}
        />

        {/* Listening / Dictation ping ring */}
        {(talkActive || dictationActive) && (
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
            filter: `drop-shadow(0 0 6px ${glowColor})`,
          }}
        >
          <path
            d="M5.2 3.8C4.1 3.15 2.75 3.95 2.75 5.22V18.78C2.75 20.05 4.1 20.85 5.2 20.2L19.4 13.42C20.52 12.88 20.52 11.12 19.4 10.58L5.2 3.8Z"
            fill={fillMain}
          />
        </svg>

        {/* Subtle click feedback ripple */}
        {isClicking && (
          <div className="absolute w-9 h-9 rounded-full border border-emerald-400/70 animate-ping pointer-events-none" />
        )}
      </div>
    </div>
  );
};
