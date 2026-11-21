import React, { useEffect, useState, useRef } from "react";
import type { OverlayPointEvent } from "../../types/events";
import { animatePointerTransition, type Point2D } from "../../lib/bezier";

interface AnimatedPointerProps {
  point?: OverlayPointEvent | null;
  onAnimationEnd?: () => void;
}

export const AnimatedPointer: React.FC<AnimatedPointerProps> = ({ point, onAnimationEnd }) => {
  const [currentPos, setCurrentPos] = useState<Point2D>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [visible, setVisible] = useState(false);
  const [rippling, setRippling] = useState(false);
  const prevPointRef = useRef<Point2D>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const cancelAnimRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!point) {
      setVisible(false);
      return;
    }

    // Convert normalized 0..1000 coordinates to actual viewport pixels
    const targetX = (point.x / 1000) * window.innerWidth;
    const targetY = (point.y / 1000) * window.innerHeight;
    const targetPoint: Point2D = { x: targetX, y: targetY };

    setVisible(true);
    setRippling(false);

    if (cancelAnimRef.current) {
      cancelAnimRef.current();
    }

    const startPoint = { ...prevPointRef.current };
    const duration = point.durationMs ?? 420;

    cancelAnimRef.current = animatePointerTransition(
      startPoint,
      targetPoint,
      duration,
      (pos) => {
        setCurrentPos(pos);
      },
      () => {
        prevPointRef.current = targetPoint;
        setRippling(true);
        onAnimationEnd?.();
      }
    );

    return () => {
      if (cancelAnimRef.current) {
        cancelAnimRef.current();
      }
    };
  }, [point, onAnimationEnd]);

  if (!visible || !point) return null;

  return (
    <div
      className="fixed pointer-events-none z-50 transition-opacity duration-300"
      style={{
        transform: `translate3d(${currentPos.x}px, ${currentPos.y}px, 0)`,
        left: 0,
        top: 0,
      }}
    >
      {/* Ripple ring on target arrival */}
      {rippling && (
        <div className="absolute -inset-6 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full border border-emerald-400 animate-ping opacity-75" />
      )}

      {/* Soft HeyClicky Emerald Glow Halo */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full blur-[9px] pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(16,185,129,0.55) 0%, rgba(16,185,129,0) 72%)",
        }}
      />

      {/* HeyClicky Rounded Emerald Triangle Pointer (tip anchored directly at target coordinate) */}
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="relative -translate-x-1/2 -translate-y-1/2 -rotate-[135deg]"
        style={{ filter: "drop-shadow(0 0 8px rgba(16,185,129,0.65))" }}
      >
        <path
          d="M5.2 3.8C4.1 3.15 2.75 3.95 2.75 5.22V18.78C2.75 20.05 4.1 20.85 5.2 20.2L19.4 13.42C20.52 12.88 20.52 11.12 19.4 10.58L5.2 3.8Z"
          fill="#008f53"
        />
      </svg>

      {/* Floating Glass Label Pill */}
      {point.label && (
        <div className="absolute left-4 top-2 pointer-events-none select-none flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-950/90 border border-emerald-400/50 shadow-[0_4px_20px_rgba(0,0,0,0.6)] backdrop-blur-md text-xs font-medium text-zinc-100 whitespace-nowrap animate-float">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>{point.label}</span>
          {point.screenIndex !== undefined && (
            <span className="text-[10px] text-zinc-400 bg-white/10 px-1.5 py-0.2 rounded-full">
              Screen {point.screenIndex}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
