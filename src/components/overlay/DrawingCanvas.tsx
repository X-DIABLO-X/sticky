import React, { useEffect, useRef, useState, useCallback } from "react";
import rough from "roughjs";
import type { OverlayDrawEvent } from "../../types/events";
import { setIgnoreCursorEvents } from "../../lib/ipc";

interface DrawingItem extends OverlayDrawEvent {
  id: string;
  createdAt: number;
  opacity: number;
}

interface DrawingCanvasProps {
  externalDrawings?: OverlayDrawEvent[];
  onScribbleFocusCrop?: (bbox: [number, number, number, number]) => void;
  onClearAll?: () => void;
}

export const DrawingCanvas: React.FC<DrawingCanvasProps> = ({
  externalDrawings = [],
  onScribbleFocusCrop,
  onClearAll,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [items, setItems] = useState<DrawingItem[]>([]);
  const [isShiftDown, setIsShiftDown] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const scribblePointsRef = useRef<Array<{ x: number; y: number }>>([]);

  // Sync external drawings
  useEffect(() => {
    if (!externalDrawings || externalDrawings.length === 0) return;

    setItems((prev) => {
      const newItems = [...prev];
      externalDrawings.forEach((d) => {
        const id = d.id || `draw-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        if (!newItems.some((item) => item.id === id)) {
          newItems.push({
            ...d,
            id,
            createdAt: Date.now(),
            opacity: 1.0,
          });
        }
      });
      return newItems;
    });
  }, [externalDrawings]);

  // Handle Shift key for Draw-to-Focus mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift" && !isShiftDown) {
        setIsShiftDown(true);
        setIgnoreCursorEvents(false);
      } else if (e.key === "Escape") {
        setItems([]);
        onClearAll?.();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        setIsShiftDown(false);
        if (!isDrawing) {
          setIgnoreCursorEvents(true);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [isShiftDown, isDrawing, onClearAll]);

  // Resize canvas to match display window
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Animation & Rendering loop for rough.js sketchy elements and auto-fade
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const rc = rough.canvas(canvas);
    const now = Date.now();

    // Render registered annotations
    items.forEach((item) => {
      const age = now - item.createdAt;
      const fadeDuration = item.fadeMs ?? 8000;
      let alpha = 1.0;

      if (!item.persistent && age > fadeDuration - 2000) {
        alpha = Math.max(0, 1 - (age - (fadeDuration - 2000)) / 2000);
      }

      if (alpha <= 0) return;

      ctx.save();
      ctx.globalAlpha = alpha;
      const stroke = item.color || "#38bdf8";
      const roughness = 1.6;

      if (item.shape === "circle" && item.coords.length >= 3) {
        const [cx, cy, r] = item.coords;
        rc.circle(cx, cy, r * 2, {
          stroke,
          strokeWidth: 2.5,
          roughness,
        });
      } else if (item.shape === "box" && item.coords.length >= 4) {
        const [x1, y1, x2, y2] = item.coords;
        const width = x2 - x1;
        const height = y2 - y1;
        rc.rectangle(x1, y1, width, height, {
          stroke,
          strokeWidth: 2.5,
          roughness,
        });
      } else if (item.shape === "arrow" && item.coords.length >= 4) {
        const [x1, y1, x2, y2] = item.coords;
        rc.line(x1, y1, x2, y2, { stroke, strokeWidth: 3, roughness: 1.2 });
        // Arrow head
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 16;
        const headAngle = Math.PI / 6;
        rc.line(
          x2,
          y2,
          x2 - headLen * Math.cos(angle - headAngle),
          y2 - headLen * Math.sin(angle - headAngle),
          { stroke, strokeWidth: 3, roughness: 1.0 }
        );
        rc.line(
          x2,
          y2,
          x2 - headLen * Math.cos(angle + headAngle),
          y2 - headLen * Math.sin(angle + headAngle),
          { stroke, strokeWidth: 3, roughness: 1.0 }
        );
      }

      // Draw label if available
      if (item.label && item.coords.length >= 2) {
        const lx = item.coords[0];
        const ly = Math.max(20, item.coords[1] - 8);
        ctx.font = "bold 13px system-ui, sans-serif";
        ctx.fillStyle = stroke;
        ctx.fillText(item.label, lx, ly);
      }

      ctx.restore();
    });

    // Render active Shift-scribble path
    if (scribblePointsRef.current.length > 1) {
      ctx.save();
      ctx.strokeStyle = "#f43f5e";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([4, 4]);

      ctx.beginPath();
      ctx.moveTo(scribblePointsRef.current[0].x, scribblePointsRef.current[0].y);
      for (let i = 1; i < scribblePointsRef.current.length; i++) {
        ctx.lineTo(scribblePointsRef.current[i].x, scribblePointsRef.current[i].y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }, [items]);

  useEffect(() => {
    let animId: number;
    const loop = () => {
      render();
      // Filter out completely faded items
      const now = Date.now();
      setItems((prev) =>
        prev.filter((it) => it.persistent || now - it.createdAt < (it.fadeMs ?? 8000))
      );
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [render]);

  // Mouse events for Shift-scribble
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isShiftDown) return;
    setIsDrawing(true);
    scribblePointsRef.current = [{ x: e.clientX, y: e.clientY }];
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing) return;
    scribblePointsRef.current.push({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);

    const pts = scribblePointsRef.current;
    if (pts.length > 2) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      pts.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });

      const bbox: [number, number, number, number] = [
        Math.round(minX),
        Math.round(minY),
        Math.round(maxX),
        Math.round(maxY),
      ];

      // Add a persistent box annotation showing what was captured
      setItems((prev) => [
        ...prev,
        {
          id: `crop-${Date.now()}`,
          shape: "box",
          coords: bbox,
          label: "Focus Crop (Vision Input)",
          color: "#f43f5e",
          createdAt: Date.now(),
          opacity: 1.0,
          fadeMs: 6000,
        },
      ]);

      onScribbleFocusCrop?.(bbox);
    }

    scribblePointsRef.current = [];
    if (!isShiftDown) {
      setIgnoreCursorEvents(true);
    }
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        className={`fixed inset-0 w-full h-full z-30 transition-all ${
          isShiftDown ? "cursor-crosshair pointer-events-auto" : "pointer-events-none"
        }`}
      />

      {/* Floating hint pill when Shift is held */}
      {isShiftDown && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 pointer-events-none px-4 py-2 rounded-full bg-rose-950/80 border border-rose-500/60 shadow-2xl backdrop-blur-md text-xs font-semibold text-rose-200 flex items-center gap-2 animate-bounce">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping" />
          <span>Draw-to-Focus Mode: Drag to circle or box area for Vision Model</span>
        </div>
      )}
    </>
  );
};
