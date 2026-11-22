import React, { useEffect, useRef, useState, useCallback } from "react";
import rough from "roughjs";
import { Pencil, Sparkles, Trash2 } from "lucide-react";
import type { OverlayDrawEvent } from "../../types/events";
import { listenEvent, setIgnoreCursorEvents } from "../../lib/ipc";

type RoughCanvasInstance = ReturnType<typeof rough.canvas>;
type RoughDrawOptions = NonNullable<Parameters<RoughCanvasInstance["line"]>[4]>;

interface DrawingItem extends OverlayDrawEvent {
  id: string;
  createdAt: number;
  opacity: number;
  seed: number;
}

interface DrawingCanvasProps {
  externalDrawings?: OverlayDrawEvent[];
  clearSignal?: number;
  guidedMode?: boolean;
  onScribbleFocusCrop?: (bbox: [number, number, number, number]) => void;
  onClearAll?: () => void;
  onRegisterToolbarRect?: (rect: DOMRect | null) => void;
}

/**
 * Deterministic positive 31-bit seed from an item's ID so Rough.js strokes
 * never jitter between 60fps animation frames (Rough.js treats seed 0 as random).
 */
function hashIdToSeed(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 2147483646) + 1;
}

/**
 * Convert a hex or rgb() color string to rgba() with the requested alpha.
 */
function colorWithAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    } else if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
  }
  const rgbMatch = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }
  return color;
}

/**
 * Slice a polyline smoothly to fraction `t` (0..1) of its total arc length.
 */
function slicePolylineByProgress(
  points: Array<[number, number]>,
  t: number
): Array<[number, number]> {
  if (points.length < 2 || t >= 0.999) return points;
  if (t <= 0) return [points[0]];

  let totalLen = 0;
  const segLens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]
    );
    segLens.push(len);
    totalLen += len;
  }
  if (totalLen <= 0.001) return points;

  const targetLen = totalLen * t;
  const out: Array<[number, number]> = [points[0]];
  let accum = 0;
  for (let i = 0; i < segLens.length; i++) {
    const segLen = segLens[i];
    if (accum + segLen >= targetLen) {
      const remain = targetLen - accum;
      const frac = segLen > 0 ? remain / segLen : 0;
      const p0 = points[i];
      const p1 = points[i + 1];
      out.push([p0[0] + (p1[0] - p0[0]) * frac, p0[1] + (p1[1] - p0[1]) * frac]);
      break;
    }
    accum += segLen;
    out.push(points[i + 1]);
  }
  return out;
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
  alpha: number,
  viewportW: number = window.innerWidth,
  viewportH: number = window.innerHeight
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = "600 13px system-ui, -apple-system, sans-serif";
  const metrics = ctx.measureText(text);
  const padX = 10;
  const pillW = metrics.width + padX * 2;
  const pillH = 26;

  // Clamp inside logical CSS viewport bounds
  const px = Math.max(8, Math.min(viewportW - pillW - 8, x));
  const py = Math.max(8, Math.min(viewportH - pillH - 8, y));

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
  guidedMode = false,
  onScribbleFocusCrop,
  onClearAll,
  onRegisterToolbarRect,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const roughCanvasRef = useRef<RoughCanvasInstance | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  const [items, setItems] = useState<DrawingItem[]>([]);
  const [sketchMode, setSketchMode] = useState(true);
  const [isShiftDown, setIsShiftDown] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  const scribblePointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const itemsRef = useRef<DrawingItem[]>(items);
  itemsRef.current = items;
  const sketchModeRef = useRef<boolean>(sketchMode);
  sketchModeRef.current = sketchMode;
  const userToggledStyleRef = useRef<boolean>(false);
  const guidedModeRef = useRef<boolean>(guidedMode);
  guidedModeRef.current = guidedMode;

  const handleClearDrawings = useCallback(() => {
    seenIdsRef.current.clear();
    setItems([]);
    onClearAll?.();
  }, [onClearAll]);

  const handleToggleSketchMode = useCallback(() => {
    userToggledStyleRef.current = true;
    setSketchMode((prev) => !prev);
  }, []);

  // Report floating toolbar DOMRect to OverlayWindow for automatic click-through toggling
  useEffect(() => {
    if (!onRegisterToolbarRect) return;

    if (items.length === 0) {
      onRegisterToolbarRect(null);
      return;
    }

    const updateRect = () => {
      const el = toolbarRef.current;
      onRegisterToolbarRect(el ? el.getBoundingClientRect() : null);
    };

    const rafId = requestAnimationFrame(updateRect);
    window.addEventListener("resize", updateRect);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", updateRect);
    };
  }, [items.length, sketchMode, onRegisterToolbarRect]);

  // Ensure toolbar rect is unregistered on unmount
  useEffect(() => {
    return () => {
      onRegisterToolbarRect?.(null);
    };
  }, [onRegisterToolbarRect]);

  // Sync external drawings (seenIdsRef prevents duplicate adds of already-seen IDs)
  useEffect(() => {
    if (!externalDrawings || externalDrawings.length === 0) return;

    const toAdd: DrawingItem[] = [];
    externalDrawings.forEach((d) => {
      const id =
        d.id ||
        `draw-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      if (!seenIdsRef.current.has(id)) {
        seenIdsRef.current.add(id);
        toAdd.push({
          ...d,
          id,
          createdAt: Date.now(),
          opacity: 1.0,
          seed: hashIdToSeed(id),
        });
      }
    });

    if (toAdd.length > 0) {
      setItems((prev) => [...prev, ...toAdd]);
    }
  }, [externalDrawings]);

  // Immediately clear drawings when clearSignal increments
  useEffect(() => {
    if (clearSignal > 0) {
      seenIdsRef.current.clear();
      setItems([]);
    }
  }, [clearSignal]);

  // Listen for backend overlay:clear_drawings event directly
  useEffect(() => {
    const unlistenClear = listenEvent("overlay:clear_drawings", () => {
      seenIdsRef.current.clear();
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
        handleClearDrawings();
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
  }, [isShiftDown, isDrawing, handleClearDrawings]);

  // Resize canvas to crisp HiDPI physical resolution
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    roughCanvasRef.current = rough.canvas(canvas);

    const updateSize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Expressive Whiteboard rendering loop (Rough.js Sketch + Clean Neon Vector across all 10 primitives)
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rc = roughCanvasRef.current ?? (roughCanvasRef.current = rough.canvas(canvas));

    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    const now = Date.now();

    // Scale normalized 0..1000 coords to viewport pixels (pass through if already > 1000)
    const sx = (v: number) => (v <= 1000 ? (v / 1000) * vw : v);
    const sy = (v: number) => (v <= 1000 ? (v / 1000) * vh : v);
    const sr = (v: number) => (v <= 1000 ? (v / 1000) * Math.min(vw, vh) : v);

    const activeItems = itemsRef.current;
    const globalSketch = sketchModeRef.current;
    const userForcedStyle = userToggledStyleRef.current;

    for (let idx = 0; idx < activeItems.length; idx++) {
      const item = activeItems[idx];
      const age = now - item.createdAt;
      const fadeDuration = item.fadeMs ?? 14000;
      // Persist by default; only fade items explicitly marked persistent === false
      const stayPersistent = item.persistent !== false;
      let alpha = 1.0;

      if (!stayPersistent) {
        const fadeWindow = Math.min(2000, fadeDuration);
        if (fadeWindow > 0 && age > fadeDuration - fadeWindow) {
          alpha = Math.max(0, 1 - (age - (fadeDuration - fadeWindow)) / fadeWindow);
        }
      }
      if (alpha <= 0) continue;

      // Smooth 320ms ease-out draw-in progress
      const rawT = Math.min(1, Math.max(0, age / 320));
      const drawT = 1 - Math.pow(1 - rawT, 3);

      const stroke = item.color || "#10b981";
      const coords = item.coords || [];
      const useSketch = userForcedStyle
        ? globalSketch
        : item.style
          ? item.style === "sketch"
          : globalSketch;

      const roughBaseOpts: RoughDrawOptions = {
        seed: item.seed,
        roughness: 1.35,
        bowing: 1.1,
        stroke,
        strokeWidth: 2.6,
      };

      ctx.save();
      ctx.globalAlpha = alpha * Math.min(1, drawT * 1.4);
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = useSketch ? 2.6 : 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = stroke;
      ctx.shadowBlur = useSketch ? 4 : 10;

      if (item.shape === "line" && coords.length >= 4) {
        const x1 = sx(coords[0]);
        const y1 = sy(coords[1]);
        const x2 = x1 + (sx(coords[2]) - x1) * drawT;
        const y2 = y1 + (sy(coords[3]) - y1) * drawT;

        if (useSketch) {
          rc.line(x1, y1, x2, y2, roughBaseOpts);
        } else {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      } else if (item.shape === "dashed" && coords.length >= 4) {
        const x1 = sx(coords[0]);
        const y1 = sy(coords[1]);
        const x2 = x1 + (sx(coords[2]) - x1) * drawT;
        const y2 = y1 + (sy(coords[3]) - y1) * drawT;

        if (useSketch) {
          rc.line(x1, y1, x2, y2, {
            ...roughBaseOpts,
            strokeLineDash: [8, 6],
            disableMultiStroke: true,
          });
        } else {
          ctx.save();
          ctx.setLineDash([8, 6]);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();
        }
      } else if (item.shape === "arrow" && coords.length >= 4) {
        const x1 = sx(coords[0]);
        const y1 = sy(coords[1]);
        const fullX2 = sx(coords[2]);
        const fullY2 = sy(coords[3]);
        const x2 = x1 + (fullX2 - x1) * drawT;
        const y2 = y1 + (fullY2 - y1) * drawT;
        const angle = Math.atan2(fullY2 - y1, fullX2 - x1);
        const trim = 8;
        const dist = Math.hypot(x2 - x1, y2 - y1);
        const shaftEndX = dist > trim ? x2 - trim * Math.cos(angle) : x2;
        const shaftEndY = dist > trim ? y2 - trim * Math.sin(angle) : y2;

        if (useSketch) {
          rc.line(x1, y1, shaftEndX, shaftEndY, roughBaseOpts);
        } else {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(shaftEndX, shaftEndY);
          ctx.stroke();
        }

        if (drawT > 0.35) {
          drawArrowHead(ctx, x2, y2, angle, stroke, 15);
        }
      } else if (item.shape === "curve" && coords.length >= 6) {
        const x1 = sx(coords[0]);
        const y1 = sy(coords[1]);
        const cx = sx(coords[2]);
        const cy = sy(coords[3]);
        const x2 = sx(coords[4]);
        const y2 = sy(coords[5]);

        // De Casteljau partial quadratic Bezier for smooth animated curve sketching
        const qx1 = x1 + (cx - x1) * drawT;
        const qy1 = y1 + (cy - y1) * drawT;
        const qx2 = cx + (x2 - cx) * drawT;
        const qy2 = cy + (y2 - cy) * drawT;
        const endX = qx1 + (qx2 - qx1) * drawT;
        const endY = qy1 + (qy2 - qy1) * drawT;

        if (useSketch) {
          rc.path(`M ${x1} ${y1} Q ${qx1} ${qy1} ${endX} ${endY}`, roughBaseOpts);
        } else {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.quadraticCurveTo(qx1, qy1, endX, endY);
          ctx.stroke();
        }

        if (drawT > 0.35) {
          const tangentAngle = Math.atan2(endY - qy1, endX - qx1);
          drawArrowHead(ctx, endX, endY, tangentAngle, stroke, 15);
        }
      } else if (item.shape === "polygon" && coords.length >= 6) {
        const vertexCount = Math.floor(coords.length / 2);
        const points: Array<[number, number]> = [];
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < vertexCount; i++) {
          const vx = sx(coords[i * 2]);
          const vy = sy(coords[i * 2 + 1]);
          points.push([vx, vy]);
          sumX += vx;
          sumY += vy;
        }
        const centX = sumX / vertexCount;
        const centY = sumY / vertexCount;

        if (useSketch) {
          ctx.save();
          if (drawT < 1) {
            const s = 0.88 + 0.12 * drawT;
            ctx.translate(centX, centY);
            ctx.scale(s, s);
            ctx.translate(-centX, -centY);
          }
          rc.polygon(points, {
            ...roughBaseOpts,
            fill: colorWithAlpha(stroke, 0.22),
            fillStyle: "hachure",
            fillWeight: 1.2,
            hachureGap: 10,
          });
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.moveTo(points[0][0], points[0][1]);
          for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i][0], points[i][1]);
          }
          ctx.closePath();

          ctx.save();
          ctx.globalAlpha = alpha * 0.16 * drawT;
          ctx.shadowBlur = 0;
          ctx.fill();
          ctx.restore();

          ctx.stroke();
        }
      } else if (item.shape === "polyline" && coords.length >= 4) {
        const vertexCount = Math.floor(coords.length / 2);
        const allPoints: Array<[number, number]> = [];
        for (let i = 0; i < vertexCount; i++) {
          allPoints.push([sx(coords[i * 2]), sy(coords[i * 2 + 1])]);
        }
        const visiblePoints = slicePolylineByProgress(allPoints, drawT);

        if (visiblePoints.length >= 2) {
          if (useSketch) {
            rc.linearPath(visiblePoints, roughBaseOpts);
          } else {
            ctx.beginPath();
            ctx.moveTo(visiblePoints[0][0], visiblePoints[0][1]);
            if (visiblePoints.length === 2) {
              ctx.lineTo(visiblePoints[1][0], visiblePoints[1][1]);
            } else {
              for (let i = 1; i < visiblePoints.length - 1; i++) {
                const midX = (visiblePoints[i][0] + visiblePoints[i + 1][0]) / 2;
                const midY = (visiblePoints[i][1] + visiblePoints[i + 1][1]) / 2;
                ctx.quadraticCurveTo(
                  visiblePoints[i][0],
                  visiblePoints[i][1],
                  midX,
                  midY
                );
              }
              const last = visiblePoints[visiblePoints.length - 1];
              ctx.lineTo(last[0], last[1]);
            }
            ctx.stroke();
          }
        }
      } else if (item.shape === "circle" && coords.length >= 3) {
        const cx = sx(coords[0]);
        const cy = sy(coords[1]);
        const r = Math.max(8, sr(coords[2]));

        if (useSketch) {
          ctx.save();
          if (drawT < 1) {
            const s = 0.85 + 0.15 * drawT;
            ctx.translate(cx, cy);
            ctx.scale(s, s);
            ctx.translate(-cx, -cy);
          }
          rc.circle(cx, cy, r * 2, {
            ...roughBaseOpts,
            fill: colorWithAlpha(stroke, 0.14),
            fillStyle: "hachure",
            fillWeight: 1.2,
            hachureGap: 11,
          });
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * drawT);

          if (drawT >= 0.99) {
            ctx.save();
            ctx.globalAlpha = alpha * 0.1;
            ctx.shadowBlur = 0;
            ctx.fill();
            ctx.restore();
          }

          ctx.stroke();
        }
      } else if (item.shape === "ellipse" && coords.length >= 4) {
        const cx = sx(coords[0]);
        const cy = sy(coords[1]);
        const rx = Math.max(8, sx(coords[2]));
        const ry = Math.max(8, sy(coords[3]));

        if (useSketch) {
          ctx.save();
          if (drawT < 1) {
            const s = 0.85 + 0.15 * drawT;
            ctx.translate(cx, cy);
            ctx.scale(s, s);
            ctx.translate(-cx, -cy);
          }
          rc.ellipse(cx, cy, rx * 2, ry * 2, {
            ...roughBaseOpts,
            fill: colorWithAlpha(stroke, 0.14),
            fillStyle: "hachure",
            fillWeight: 1.2,
            hachureGap: 11,
          });
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.ellipse(
            cx,
            cy,
            rx,
            ry,
            0,
            -Math.PI / 2,
            -Math.PI / 2 + Math.PI * 2 * drawT
          );

          if (drawT >= 0.99) {
            ctx.save();
            ctx.globalAlpha = alpha * 0.1;
            ctx.shadowBlur = 0;
            ctx.fill();
            ctx.restore();
          }

          ctx.stroke();
        }
      } else if (item.shape === "box" && coords.length >= 4) {
        const rx1 = sx(coords[0]);
        const ry1 = sy(coords[1]);
        const rx2 = sx(coords[2]);
        const ry2 = sy(coords[3]);
        const cx = (rx1 + rx2) / 2;
        const cy = (ry1 + ry2) / 2;
        const fullW = Math.max(8, Math.abs(rx2 - rx1));
        const fullH = Math.max(8, Math.abs(ry2 - ry1));
        const fullX = Math.min(rx1, rx2);
        const fullY = Math.min(ry1, ry2);

        if (useSketch) {
          ctx.save();
          if (drawT < 1) {
            const s = 0.85 + 0.15 * drawT;
            ctx.translate(cx, cy);
            ctx.scale(s, s);
            ctx.translate(-cx, -cy);
          }
          rc.rectangle(fullX, fullY, fullW, fullH, {
            ...roughBaseOpts,
            fill: colorWithAlpha(stroke, 0.12),
            fillStyle: "solid",
            fillWeight: 1.2,
          });
          ctx.restore();
        } else {
          const scale = 0.85 + 0.15 * drawT;
          const width = fullW * scale;
          const height = fullH * scale;
          const x = cx - width / 2;
          const y = cy - height / 2;

          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, width, height, 8);
          } else {
            ctx.rect(x, y, width, height);
          }

          ctx.save();
          ctx.globalAlpha = alpha * 0.12 * drawT;
          ctx.shadowBlur = 0;
          ctx.fill();
          ctx.restore();

          ctx.stroke();
        }
      } else if (item.shape === "text" && coords.length >= 2 && item.label) {
        const tx = sx(coords[0]);
        const ty = sy(coords[1]);
        drawLabelPill(ctx, tx, ty, item.label, stroke, alpha * drawT, vw, vh);
      }

      // Optional floating label pill for non-text shapes
      if (
        item.shape !== "text" &&
        item.label &&
        item.label.trim() &&
        coords.length >= 2
      ) {
        let anchorX = sx(coords[0]);
        let topY = sy(coords[1]);
        let bottomY = topY + 16;

        if (item.shape === "box" && coords.length >= 4) {
          const y1 = sy(coords[1]);
          const y2 = sy(coords[3]);
          anchorX = Math.min(sx(coords[0]), sx(coords[2]));
          topY = Math.min(y1, y2);
          bottomY = Math.max(y1, y2);
        } else if (item.shape === "circle" && coords.length >= 3) {
          const r = Math.max(8, sr(coords[2]));
          anchorX = sx(coords[0]) - r;
          topY = sy(coords[1]) - r;
          bottomY = sy(coords[1]) + r;
        } else if (item.shape === "ellipse" && coords.length >= 4) {
          const rx = Math.max(8, sx(coords[2]));
          const ry = Math.max(8, sy(coords[3]));
          anchorX = sx(coords[0]) - rx;
          topY = sy(coords[1]) - ry;
          bottomY = sy(coords[1]) + ry;
        } else if (
          (item.shape === "polygon" && coords.length >= 6) ||
          (item.shape === "polyline" && coords.length >= 4)
        ) {
          const vertexCount = Math.floor(coords.length / 2);
          let minX = Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (let i = 0; i < vertexCount; i++) {
            const vx = sx(coords[i * 2]);
            const vy = sy(coords[i * 2 + 1]);
            if (vx < minX) minX = vx;
            if (vy < minY) minY = vy;
            if (vy > maxY) maxY = vy;
          }
          anchorX = minX;
          topY = minY;
          bottomY = maxY;
        }

        const ly = topY >= 44 ? topY - 34 : bottomY + 8;
        drawLabelPill(
          ctx,
          anchorX,
          ly,
          item.label.trim(),
          stroke,
          alpha * drawT,
          vw,
          vh
        );
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
      // Only prune non-persistent items (persistent !== false stays until explicitly cleared)
      const now = Date.now();
      setItems((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.filter(
          (it) =>
            it.persistent !== false ||
            now - it.createdAt < (it.fadeMs ?? 14000)
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

      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const normalizedCoords = [
        Math.round((minX / vw) * 1000),
        Math.round((minY / vh) * 1000),
        Math.round((maxX / vw) * 1000),
        Math.round((maxY / vh) * 1000),
      ];

      const cropId = `crop-${Date.now()}`;
      // Add a temporary auto-fading box annotation showing what was captured
      setItems((prev) => [
        ...prev,
        {
          id: cropId,
          shape: "box",
          coords: normalizedCoords,
          label: "Focus Crop (Vision Input)",
          color: "#f43f5e",
          createdAt: Date.now(),
          opacity: 1.0,
          fadeMs: 6000,
          persistent: false,
          seed: hashIdToSeed(cropId),
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

      {/* Floating Drawing Controls Mini-Pill */}
      {items.length > 0 && (
        <div
          ref={toolbarRef}
          onMouseEnter={() => {
            if (!onRegisterToolbarRect) setIgnoreCursorEvents(false);
          }}
          onMouseLeave={() => {
            if (!onRegisterToolbarRect && !isShiftDown && !isDrawing) {
              setIgnoreCursorEvents(true);
            }
          }}
          className="fixed bottom-5 left-5 z-50 pointer-events-auto bg-zinc-950/90 border border-emerald-400/40 backdrop-blur-md shadow-2xl rounded-full px-3 py-1.5 flex items-center gap-2 text-xs text-zinc-100 select-none"
        >
          <span className="flex items-center gap-1.5 font-medium text-emerald-300 tabular-nums">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            {items.length} {items.length === 1 ? "drawing" : "drawings"}
          </span>

          <span className="h-3.5 w-px bg-white/15" />

          <button
            type="button"
            onClick={handleToggleSketchMode}
            title={
              sketchMode
                ? "Switch to Clean Neon Vector mode"
                : "Switch to Hand-Drawn Sketch mode"
            }
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold transition-colors ${
              sketchMode
                ? "bg-amber-500/20 text-amber-200 border border-amber-400/40 hover:bg-amber-500/30"
                : "bg-emerald-500/20 text-emerald-200 border border-emerald-400/40 hover:bg-emerald-500/30"
            }`}
          >
            {sketchMode ? (
              <>
                <Pencil className="w-3 h-3" />
                Sketch
              </>
            ) : (
              <>
                <Sparkles className="w-3 h-3" />
                Neon
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleClearDrawings}
            title="Clear all drawings (Esc)"
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/15 text-rose-200 border border-rose-400/35 hover:bg-rose-500/30 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Clear (Esc)
          </button>
        </div>
      )}

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
