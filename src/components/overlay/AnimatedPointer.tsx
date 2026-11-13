import React, { useEffect, useState, useRef } from "react";
import type { OverlayPointEvent } from "../../types/events";
import { animatePointerTransition, type Point2D } from "../../lib/bezier";
import { Navigation } from "lucide-react";

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
        <div className="absolute -inset-6 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full border border-sky-400 animate-ping opacity-75" />
      )}

      {/* Outer Glow Halo */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-sky-500/30 blur-md pointer-events-none" />

      {/* Center Target Dot & Icon */}
      <div className="relative -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded-full bg-gradient-to-br from-sky-400 to-blue-600 shadow-[0_0_15px_rgba(56,189,248,0.8)] border border-white/60">
        <Navigation className="w-3.5 h-3.5 text-white transform -rotate-45" />
      </div>

      {/* Floating Glass Label Pill */}
      {point.label && (
        <div className="absolute left-4 top-2 pointer-events-none select-none flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900/90 border border-sky-400/50 shadow-[0_4px_20px_rgba(0,0,0,0.6)] backdrop-blur-md text-xs font-medium text-slate-100 whitespace-nowrap animate-float">
          <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
          <span>{point.label}</span>
          {point.screenIndex !== undefined && (
            <span className="text-[10px] text-slate-400 bg-white/10 px-1.5 py-0.2 rounded-full">
              Screen {point.screenIndex}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
