import React, { useEffect, useRef, useState, useCallback } from "react";
import type { OverlayDrawEvent } from "../../types/events";
import { listenEvent, setIgnoreCursorEvents } from "../../lib/ipc";

interface DrawingItem extends OverlayDrawEvent {
  id: string;
  createdAt: number;
  opacity: number;
}

interface DrawingCanvasProps {
  externalDrawings?: OverlayDrawEvent[];
  clearSignal?: number;
  onScribbleFocusCrop?: (bbox: [number, number, number, number]) => void;
  onClearAll?: () => void;
}

/**
 * Draw a crisp filled triangular arrowhead at (tipX, tipY) pointing along `angle`.
 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  angle: number,
  color: string,
  headLen = 14
) {
  const spread = Math.PI / 6.5;
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - headLen * Math.cos(angle - spread),
    tipY - headLen * Math.sin(angle - spread)
  );
  ctx.lineTo(
    tipX - headLen * Math.cos(angle + spread),
    tipY - headLen * Math.sin(angle + spread)
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Draw a dark-glass floating annotation pill with colored border & bold white text.
 */
function drawLabelPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  accentColor: string,
  alpha: number
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = "600 13px system-ui, -apple-system, sans-serif";
  const metrics = ctx.measureText(text);
  const padX = 10;
  const pillW = metrics.width + padX * 2;
  const pillH = 26;

  // Clamp inside viewport bounds
  const px = Math.max(8, Math.min(ctx.canvas.width - pillW - 8, x));
  const py = Math.max(8, Math.min(ctx.canvas.height - pillH - 8, y));

  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;

  ctx.fillStyle = "rgba(9, 9, 11, 0.9)";
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(px, py, pillW, pillH, 999);
  } else {
    ctx.rect(px, py, pillW, pillH);
  }
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, px + padX, py + pillH / 2 + 0.5);
  ctx.restore();
}

export const DrawingCanvas: React.FC<DrawingCanvasProps> = ({
  externalDrawings = [],
  clearSignal = 0,
  onScribbleFocusCrop,
  onClearAll,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [items, setItems] = useState<DrawingItem[]>([]);
  const [isShiftDown, setIsShiftDown] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const scribblePointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const itemsRef = useRef<DrawingItem[]>(items);
  itemsRef.current = items;

  // Sync external drawings
  useEffect(() => {
    if (!externalDrawings || externalDrawings.length === 0) return;

    setItems((prev) => {
      const newItems = [...prev];
      externalDrawings.forEach((d) => {
        const id =
          d.id ||
          `draw-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
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

  // Immediately clear drawings when clearSignal increments
  useEffect(() => {
    if (clearSignal > 0) {
      setItems([]);
    }
  }, [clearSignal]);

  // Listen for backend overlay:clear_drawings event directly
  useEffect(() => {
    const unlistenClear = listenEvent("overlay:clear_drawings", () => {
      setItems([]);
    });
    return () => {
      unlistenClear.then((u) => u());
    };
  }, []);

  // Handle Shift key for Draw-to-Focus mode and Escape to clear
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

  // Expressive Vector Whiteboard rendering loop (all 7 primitives + auto-fade + Shift-scribble)
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const vw = canvas.width;
    const vh = canvas.height;
    const now = Date.now();

    // Scale normalized 0..1000 coords to viewport pixels (pass through if already > 1000)
    const sx = (v: number) => (v <= 1000 ? (v / 1000) * vw : v);
    const sy = (v: number) => (v <= 1000 ? (v / 1000) * vh : v);
    const sr = (v: number) => (v <= 1000 ? (v / 1000) * Math.min(vw, vh) : v);

    const activeItems = itemsRef.current;
    for (let idx = 0; idx < activeItems.length; idx++) {
      const item = activeItems[idx];
      const age = now - item.createdAt;
      const fadeDuration = item.fadeMs ?? 8000;
      let alpha = 1.0;

      if (!item.persistent && age > fadeDuration - 2000) {
        alpha = Math.max(0, 1 - (age - (fadeDuration - 2000)) / 2000);
      }
      if (alpha <= 0) continue;

      const stroke = item.color || "#10b981";
      const coords = item.coords || [];

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = stroke;
      ctx.shadowBlur = 10;

      if (item.shape === "line" && coords.length >= 4) {
        const x1 = sx(coords[0]);
        const y1 = sy(coords[1]);
        const x2 = sx(coords[2]);
        const y2 = sy(coords[3]);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      } else if (item.shape === "arrow" && coords.length >= 4) {
        const x1 = sx(coords[0]);
        const y1 = sy(coords[1]);
        const x2 = sx(coords[2]);
        const y2 = sy(coords[3]);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const trim = 8;
        const dist = Math.hypot(x2 - x1, y2 - y1);
        const shaftEndX = dist > trim ? x2 - trim * Math.cos(angle) : x2;
        const shaftEndY = dist > trim ? y2 - trim * Math.sin(angle) : y2;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(shaftEndX, shaftEndY);
        ctx.stroke();

        drawArrowHead(ctx, x2, y2, angle, stroke, 15);
      } else if (item.shape === "curve" && coords.length >= 6) {
        const x1 = sx(coords[0]);
        const y1 = sy(coords[1]);
        const cx = sx(coords[2]);
        const cy = sy(coords[3]);
        const x2 = sx(coords[4]);
        const y2 = sy(coords[5]);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(cx, cy, x2, y2);
        ctx.stroke();

        // Directional arrowhead aligned with end tangent (x2 - cx, y2 - cy)
        const tangentAngle = Math.atan2(y2 - cy, x2 - cx);
        drawArrowHead(ctx, x2, y2, tangentAngle, stroke, 15);
      } else if (item.shape === "polygon" && coords.length >= 6) {
        const vertexCount = Math.floor(coords.length / 2);
        ctx.beginPath();
        ctx.moveTo(sx(coords[0]), sy(coords[1]));
        for (let i = 1; i < vertexCount; i++) {
          ctx.lineTo(sx(coords[i * 2]), sy(coords[i * 2 + 1]));
        }
        ctx.closePath();

        // Soft translucent fill
        ctx.save();
        ctx.globalAlpha = alpha * 0.16;
        ctx.shadowBlur = 0;
        ctx.fill();
        ctx.restore();

        // Crisp glowing stroke
        ctx.stroke();
      } else if (item.shape === "circle" && coords.length >= 3) {
        const cx = sx(coords[0]);
        const cy = sy(coords[1]);
        const r = Math.max(8, sr(coords[2]));

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);

        ctx.save();
        ctx.globalAlpha = alpha * 0.1;
        ctx.shadowBlur = 0;
        ctx.fill();
        ctx.restore();

        ctx.stroke();
      } else if (item.shape === "box" && coords.length >= 4) {
        const rx1 = sx(coords[0]);
        const ry1 = sy(coords[1]);
        const rx2 = sx(coords[2]);
        const ry2 = sy(coords[3]);
        const x = Math.min(rx1, rx2);
        const y = Math.min(ry1, ry2);
        const width = Math.max(8, Math.abs(rx2 - rx1));
        const height = Math.max(8, Math.abs(ry2 - ry1));

        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(x, y, width, height, 8);
        } else {
          ctx.rect(x, y, width, height);
        }

        // Soft translucent fill (0.12 alpha)
        ctx.save();
        ctx.globalAlpha = alpha * 0.12;
        ctx.shadowBlur = 0;
        ctx.fill();
        ctx.restore();

        // Crisp 2.5px glowing stroke
        ctx.stroke();
      } else if (item.shape === "text" && coords.length >= 2 && item.label) {
        const tx = sx(coords[0]);
        const ty = sy(coords[1]);
        drawLabelPill(ctx, tx, ty, item.label, stroke, alpha);
      }

      // Optional floating label pill for non-text shapes
      if (item.shape !== "text" && item.label && coords.length >= 2) {
        const lx = sx(coords[0]);
        const ly = Math.max(8, sy(coords[1]) - 34);
        drawLabelPill(ctx, lx, ly, item.label, stroke, alpha);
      }

      ctx.restore();
    }

    // Render active Shift-scribble path
    if (scribblePointsRef.current.length > 1) {
      ctx.save();
      ctx.strokeStyle = "#f43f5e";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([4, 4]);

      ctx.beginPath();
      ctx.moveTo(
        scribblePointsRef.current[0].x,
        scribblePointsRef.current[0].y
      );
      for (let i = 1; i < scribblePointsRef.current.length; i++) {
        ctx.lineTo(
          scribblePointsRef.current[i].x,
          scribblePointsRef.current[i].y
        );
      }
      ctx.stroke();
      ctx.restore();
    }
  }, []);

  useEffect(() => {
    let animId: number;
    const loop = () => {
      render();
      // Filter out completely faded items without triggering redundant React re-renders
      const now = Date.now();
      setItems((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.filter(
          (it) => it.persistent || now - it.createdAt < (it.fadeMs ?? 8000)
        );
        return next.length === prev.length ? prev : next;
      });
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

      const vw = canvasRef.current?.width || window.innerWidth;
      const vh = canvasRef.current?.height || window.innerHeight;
      const normalizedCoords = [
        Math.round((minX / vw) * 1000),
        Math.round((minY / vh) * 1000),
        Math.round((maxX / vw) * 1000),
        Math.round((maxY / vh) * 1000),
      ];

      // Add a box annotation showing what was captured
      setItems((prev) => [
        ...prev,
        {
          id: `crop-${Date.now()}`,
          shape: "box",
          coords: normalizedCoords,
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
          isShiftDown
            ? "cursor-crosshair pointer-events-auto"
            : "pointer-events-none"
        }`}
      />

      {/* Floating hint pill when Shift is held */}
      {isShiftDown && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 pointer-events-none px-4 py-2 rounded-full bg-rose-950/80 border border-rose-500/60 shadow-2xl backdrop-blur-md text-xs font-semibold text-rose-200 flex items-center gap-2 animate-bounce">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping" />
          <span>
            Draw-to-Focus Mode: Drag to circle or box area for Vision Model
          </span>
        </div>
      )}
    </>
  );
};
