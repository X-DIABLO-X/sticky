import gsap from "gsap";
import katex from "katex";
import "katex/dist/katex.min.css";

/* ============================================================================
 * PUBLIC CONTRACTS (imported by VisualizationStage & overlay controllers)
 * ============================================================================ */

export interface ManimBeatInfo {
  index: number;
  title: string;
  subtitle: string;
  startTime: number;
  duration: number;
}

export interface ManimController {
  play: () => void;
  pause: () => void;
  restart: () => void;
  seek: (seconds: number) => void;
  setSpeed: (rate: number) => void;
  jumpToBeat: (beatIndex: number) => void;
  getDuration: () => number;
  getTime: () => number;
  getBeats: () => ManimBeatInfo[];
  resize: () => void;
  dispose: () => void;
}

export interface ManimMountOptions {
  canvas: HTMLCanvasElement;
  overlayLayer: HTMLDivElement;
  code: string;
  onStateChange?: (state: {
    playing: boolean;
    time: number;
    duration: number;
    activeBeatIndex: number;
    subtitle: string;
    beats: ManimBeatInfo[];
  }) => void;
  onError?: (message: string) => void;
}

/* ============================================================================
 * PALETTE & HELPERS
 * ============================================================================ */

export const COLORS = {
  emerald: "#10b981",
  emeraldLight: "#34d399",
  cyan: "#38bdf8",
  blue: "#60a5fa",
  amber: "#f59e0b",
  purple: "#a855f7",
  rose: "#f43f5e",
  white: "#f4f4f5",
  muted: "#94a3b8",
  grid: "rgba(148,163,184,0.12)",
} as const;

type Vec2 = [number, number];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function stripCodeFences(raw: string): string {
  const trimmed = (raw || "").trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  return match ? match[1].trim() : trimmed;
}

function withAlpha(color: string, alpha: number): string {
  const a = clamp(alpha, 0, 1);
  if (!color) return `rgba(244,244,245,${a})`;
  const c = color.trim();
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
  }
  const rgbaMatch = c.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(",").map((p) => p.trim());
    if (parts.length >= 3) {
      return `rgba(${parts[0]},${parts[1]},${parts[2]},${a})`;
    }
  }
  return c;
}

function niceStep(range: number, targetTicks = 6): number {
  const span = Math.abs(range);
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rough = span / Math.max(2, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  if (norm < 1.5) return 1 * mag;
  if (norm < 3.5) return 2 * mag;
  if (norm < 7.5) return 5 * mag;
  return 10 * mag;
}

function formatTick(val: number): string {
  if (Math.abs(val) < 1e-9) return "0";
  if (Math.abs(val - Math.round(val)) < 1e-6) return String(Math.round(val));
  return Number(val.toFixed(2)).toString();
}

function resolveRadiusPx(r: number, W: number, H: number): number {
  return r <= 1 ? r * Math.min(W, H) : r;
}

function resolveDimPx(val: number, axisPx: number): number {
  return val <= 1 ? val * axisPx : val;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  angle: number,
  size: number,
  color: string
): void {
  const back = size;
  const wing = size * 0.44;
  const notch = size * 0.72;
  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-back, -wing);
  ctx.lineTo(-notch, 0);
  ctx.lineTo(-back, wing);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ============================================================================
 * MOBJECT DEFINITIONS
 * ============================================================================ */

interface BaseMobject {
  id: string;
  kind: string;
  x: number;
  y: number;
  opacity: number;
  drawProgress: number;
  scale: number;
  rotation: number;
  glowIntensity: number;
  color: string;
  offsetY: number;
  zIndex: number;
  _added?: boolean;
}

interface CommonOpts {
  x?: number;
  y?: number;
  color?: string;
  visible?: boolean;
  scale?: number;
  rotation?: number;
  glowIntensity?: number;
  zIndex?: number;
}

export interface AxesMobject extends BaseMobject {
  kind: "axes";
  xRange: [number, number];
  yRange: [number, number];
  w: number;
  h: number;
  xLabel: string;
  yLabel: string;
  grid: boolean;
  isPlane: boolean;
  xStep?: number;
  yStep?: number;
  gridColor: string;
  showTicks: boolean;
  showNumbers: boolean;
  toNorm: (mx: number, my: number) => Vec2;
  toPx: (mx: number, my: number, W: number, H: number) => Vec2;
  c2p: (mx: number, my: number) => Vec2;
}

interface CurveSegment {
  axes: AxesMobject;
  fn: (x: number) => number;
  x0: number;
  x1: number;
  p: number;
  color: string;
  tangentArrow?: ArrowMobject;
  tangentLength?: number;
  tangentScale?: number;
  downhill?: boolean;
  constantLength?: boolean;
}

interface PlotMobject extends BaseMobject {
  kind: "plot";
  fn: (x: number) => number;
  axes: AxesMobject;
  domain?: [number, number];
  width: number;
  label: string;
  fillUnder: boolean | string;
  samples: number;
  dashed: boolean;
}

interface DotMobject extends BaseMobject {
  kind: "dot";
  axes?: AxesMobject;
  radius: number;
  glow: boolean;
  label: string;
  labelOffset?: Vec2;
  traceEnabled: boolean;
  traceColor: string;
  trail: Array<{ x: number; y: number }>;
  _curveSegments: CurveSegment[];
  _lastTrailPt?: { x: number; y: number };
  _autoTangentArrow?: ArrowMobject;
}

interface CircleMobject extends BaseMobject {
  kind: "circle";
  r: number;
  fill?: string;
  width: number;
  label: string;
  dashed: boolean;
}

interface RectMobject extends BaseMobject {
  kind: "rect";
  w: number;
  h: number;
  radius: number;
  fill?: string;
  width: number;
  label: string;
  dashed: boolean;
}

interface PolygonMobject extends BaseMobject {
  kind: "polygon";
  points: Vec2[];
  axes?: AxesMobject;
  fill?: string;
  width: number;
  label: string;
  closed: boolean;
}

interface ArcMobject extends BaseMobject {
  kind: "arc";
  r: number;
  startAngle: number;
  endAngle: number;
  width: number;
  label: string;
  dashed: boolean;
}

interface LineMobject extends BaseMobject {
  kind: "line";
  from: EndpointRef;
  to: EndpointRef;
  axes?: AxesMobject;
  width: number;
  dashed: boolean;
  label: string;
}

interface ArrowMobject extends BaseMobject {
  kind: "arrow";
  from: EndpointRef;
  to: EndpointRef;
  axes?: AxesMobject;
  width: number;
  headSize: number;
  dashed: boolean;
  label: string;
  _tangentInit?: boolean;
}

interface NodeMobject extends BaseMobject {
  kind: "node";
  r: number;
  label: string;
  sublabel: string;
  shape: "circle" | "rounded" | "box" | "diamond" | "hexagon";
  fill?: string;
  width: number;
}

type EndpointRef = Vec2 | NodeMobject | DotMobject | BaseMobject;

interface EdgeMobject extends BaseMobject {
  kind: "edge";
  from: EndpointRef;
  to: EndpointRef;
  width: number;
  label: string;
  curved: number;
  arrow: boolean;
  dashed: boolean;
}

interface BarChartMobject extends BaseMobject {
  kind: "barchart";
  w: number;
  h: number;
  labels: string[];
  values: number[];
  maxVal?: number;
  colors?: string[];
  title: string;
  showValues: boolean;
  unit: string;
}

interface SpringMobject extends BaseMobject {
  kind: "spring";
  from: EndpointRef;
  to: EndpointRef;
  coils: number;
  amplitude: number;
  width: number;
  label: string;
}

interface TextMobject extends BaseMobject {
  kind: "text";
  text: string;
  size: number;
  align: CanvasTextAlign;
  weight: string;
  font?: string;
  bg: boolean | string;
  padding: number;
  maxWidth?: number;
}

interface MathTexMobject extends BaseMobject {
  kind: "mathtex";
  latex: string;
  size: number;
  bg: boolean | string;
  displayMode: boolean;
  align: "left" | "center" | "right";
  _el?: HTMLDivElement;
  _renderedLatex?: string;
  setTex: (latex: string) => void;
}

type AnyMobject =
  | AxesMobject
  | PlotMobject
  | DotMobject
  | CircleMobject
  | RectMobject
  | PolygonMobject
  | ArcMobject
  | LineMobject
  | ArrowMobject
  | NodeMobject
  | EdgeMobject
  | BarChartMobject
  | SpringMobject
  | TextMobject
  | MathTexMobject;

interface PacketState {
  target: EdgeMobject | [EndpointRef, EndpointRef] | { from: EndpointRef; to: EndpointRef };
  t: number;
  opacity: number;
  color: string;
  size: number;
}

interface MoveAlongCurveOpts {
  tangentArrow?: ArrowMobject | boolean;
  tangentLength?: number;
  tangentScale?: number;
  downhill?: boolean;
  constantLength?: boolean;
  ease?: string;
  at?: gsap.Position;
  traceColor?: string;
}

/* ============================================================================
 * ENDPOINT & CURVE GEOMETRY HELPERS
 * ============================================================================ */

function isEndpointMobject(ref: EndpointRef): ref is BaseMobject {
  return Boolean(ref && typeof ref === "object" && !Array.isArray(ref) && "kind" in ref);
}

function endpointToPx(
  ref: EndpointRef,
  W: number,
  H: number,
  axes?: AxesMobject
): { x: number; y: number; trimR: number } {
  if (Array.isArray(ref)) {
    if (axes) {
      const [px, py] = axes.toPx(ref[0], ref[1], W, H);
      return { x: px, y: py, trimR: 0 };
    }
    return { x: ref[0] * W, y: ref[1] * H, trimR: 0 };
  }
  if (isEndpointMobject(ref)) {
    if (ref.kind === "dot") {
      const dot = ref as DotMobject;
      const [px, py] = dot.axes ? dot.axes.toPx(dot.x, dot.y, W, H) : [dot.x * W, dot.y * H];
      return { x: px, y: py, trimR: dot.radius * dot.scale + 2 };
    }
    if (ref.kind === "node") {
      const node = ref as NodeMobject;
      const rPx = resolveRadiusPx(node.r, W, H) * node.scale;
      return { x: node.x * W, y: node.y * H, trimR: rPx + 2 };
    }
    return { x: ref.x * W, y: ref.y * H, trimR: 0 };
  }
  return { x: 0, y: 0, trimR: 0 };
}

function evalEdgeGeometry(
  fromRef: EndpointRef,
  toRef: EndpointRef,
  curved: number,
  W: number,
  H: number
): {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  isCurved: boolean;
  pointAt: (t: number) => Vec2;
  tangentAt: (t: number) => number;
} {
  const a = endpointToPx(fromRef, W, H);
  const b = endpointToPx(toRef, W, H);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;

  // Trim cleanly to node perimeter if connecting nodes
  const trimA = Math.min(a.trimR, dist * 0.42);
  const trimB = Math.min(b.trimR, dist * 0.42);
  const x0 = a.x + ux * trimA;
  const y0 = a.y + uy * trimA;
  const x1 = b.x - ux * trimB;
  const y1 = b.y - uy * trimB;

  const isCurved = Math.abs(curved) > 1e-4;
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const nx = -uy;
  const ny = ux;
  const bend = curved * dist;
  const cx = mx + nx * bend;
  const cy = my + ny * bend;

  const pointAt = (t: number): Vec2 => {
    const u = clamp(t, 0, 1);
    if (!isCurved) {
      return [lerp(x0, x1, u), lerp(y0, y1, u)];
    }
    const omt = 1 - u;
    return [
      omt * omt * x0 + 2 * omt * u * cx + u * u * x1,
      omt * omt * y0 + 2 * omt * u * cy + u * u * y1,
    ];
  };

  const tangentAt = (t: number): number => {
    const u = clamp(t, 0, 1);
    if (!isCurved) {
      return Math.atan2(y1 - y0, x1 - x0);
    }
    const dtx = 2 * (1 - u) * (cx - x0) + 2 * u * (x1 - cx);
    const dty = 2 * (1 - u) * (cy - y0) + 2 * u * (y1 - cy);
    return Math.atan2(dty, dtx);
  };

  return { x0, y0, cx, cy, x1, y1, isCurved, pointAt, tangentAt };
}

function updateTangentArrowForCurve(
  arrow: ArrowMobject,
  axes: AxesMobject,
  fn: (x: number) => number,
  mx: number,
  my: number,
  opts?: MoveAlongCurveOpts
): void {
  const h = 1e-4;
  const yPlus = fn(mx + h);
  const yMinus = fn(mx - h);
  const slope = Number.isFinite(yPlus) && Number.isFinite(yMinus) ? (yPlus - yMinus) / (2 * h) : 0;

  const downhill = opts?.downhill !== false;
  const maxLen = opts?.tangentLength ?? 1.45;
  const slopeScale = opts?.tangentScale ?? 0.72;

  let dx = 0;
  let dy = 0;

  if (downhill) {
    const absSlope = Math.abs(slope);
    if (absSlope > 1e-3) {
      const sign = -Math.sign(slope);
      const mag = Math.hypot(1, slope);
      const len = opts?.constantLength ? maxLen : Math.min(maxLen, absSlope * slopeScale);
      dx = (sign / mag) * len;
      dy = ((sign * slope) / mag) * len;
    }
  } else {
    const mag = Math.hypot(1, slope);
    const len = maxLen;
    dx = (1 / mag) * len;
    dy = (slope / mag) * len;
  }

  const endX = mx + dx;
  const endY = my + dy;

  if (arrow.axes) {
    arrow.from = [mx, my];
    arrow.to = [endX, endY];
  } else {
    arrow.from = axes.toNorm(mx, my);
    arrow.to = axes.toNorm(endX, endY);
  }
}

/* ============================================================================
 * MOBJECT FACTORY (`M.*`)
 * ============================================================================ */

function createMobjectFactory() {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}`;

  function base(kind: string, opts: CommonOpts = {}, defaultColor: string = COLORS.cyan): BaseMobject {
    const visible = Boolean(opts.visible);
    return {
      id: nextId(kind),
      kind,
      x: opts.x ?? 0.5,
      y: opts.y ?? 0.5,
      opacity: visible ? 1 : 0,
      drawProgress: visible ? 1 : 0,
      scale: opts.scale ?? 1,
      rotation: opts.rotation ?? 0,
      glowIntensity: opts.glowIntensity ?? 1,
      color: opts.color ?? defaultColor,
      offsetY: 0,
      zIndex: opts.zIndex ?? 0,
    };
  }

  function makeAxes(
    opts: CommonOpts & {
      xRange?: [number, number];
      yRange?: [number, number];
      w?: number;
      h?: number;
      xLabel?: string;
      yLabel?: string;
      grid?: boolean;
      xStep?: number;
      yStep?: number;
      gridColor?: string;
      showTicks?: boolean;
      showNumbers?: boolean;
    } = {},
    isPlane = false
  ): AxesMobject {
    const b = base("axes", { x: 0.5, y: 0.54, ...opts }, COLORS.muted);
    const ax: AxesMobject = {
      ...b,
      kind: "axes",
      xRange: opts.xRange ?? [-4, 4],
      yRange: opts.yRange ?? [-2, 4],
      w: opts.w ?? 0.78,
      h: opts.h ?? 0.66,
      xLabel: opts.xLabel ?? "",
      yLabel: opts.yLabel ?? "",
      grid: isPlane ? true : (opts.grid ?? true),
      isPlane,
      xStep: opts.xStep,
      yStep: opts.yStep,
      gridColor: opts.gridColor ?? (isPlane ? "rgba(56,189,248,0.16)" : COLORS.grid),
      showTicks: opts.showTicks ?? true,
      showNumbers: opts.showNumbers ?? true,
      toNorm(mx: number, my: number): Vec2 {
        const [xMin, xMax] = ax.xRange;
        const [yMin, yMax] = ax.yRange;
        const u = (mx - xMin) / (xMax - xMin || 1);
        const v = (my - yMin) / (yMax - yMin || 1);
        const nx = ax.x - ax.w * 0.5 + u * ax.w;
        const ny = ax.y + ax.h * 0.5 - v * ax.h;
        return [nx, ny];
      },
      toPx(mx: number, my: number, W: number, H: number): Vec2 {
        const [nx, ny] = ax.toNorm(mx, my);
        return [nx * W, ny * H];
      },
      c2p(mx: number, my: number): Vec2 {
        return ax.toNorm(mx, my);
      },
    };
    return ax;
  }

  return {
    Axes(opts?: Parameters<typeof makeAxes>[0]): AxesMobject {
      return makeAxes(opts, false);
    },

    NumberPlane(opts?: Parameters<typeof makeAxes>[0]): AxesMobject {
      return makeAxes({ grid: true, ...opts }, true);
    },

    Plot(
      fnOrOpts:
        | ((x: number) => number)
        | (CommonOpts & {
            fn: (x: number) => number;
            axes: AxesMobject;
            domain?: [number, number];
            width?: number;
            label?: string;
            fillUnder?: boolean | string;
            samples?: number;
            dashed?: boolean;
          }),
      maybeOpts: CommonOpts & {
        axes?: AxesMobject;
        domain?: [number, number];
        width?: number;
        label?: string;
        fillUnder?: boolean | string;
        samples?: number;
        dashed?: boolean;
      } = {}
    ): PlotMobject {
      const fn = typeof fnOrOpts === "function" ? fnOrOpts : fnOrOpts.fn;
      const opts = typeof fnOrOpts === "function" ? maybeOpts : fnOrOpts;
      const axes = opts.axes ?? makeAxes();
      const b = base("plot", opts, COLORS.cyan);
      return {
        ...b,
        kind: "plot",
        fn,
        axes,
        domain: opts.domain,
        width: opts.width ?? 2.8,
        label: opts.label ?? "",
        fillUnder: opts.fillUnder ?? false,
        samples: opts.samples ?? 180,
        dashed: Boolean(opts.dashed),
      };
    },

    Dot(
      opts: CommonOpts & {
        axes?: AxesMobject;
        radius?: number;
        r?: number;
        glow?: boolean;
        label?: string;
        labelOffset?: Vec2;
        trace?: boolean;
        traceColor?: string;
      } = {}
    ): DotMobject {
      const defaultPos = opts.axes ? { x: 0, y: 0 } : { x: 0.5, y: 0.5 };
      const b = base("dot", { ...defaultPos, ...opts }, COLORS.emerald);
      const rawR = opts.radius ?? opts.r ?? 7.5;
      const radiusPx = rawR > 0 && rawR <= 1 ? Math.max(4, rawR * 360) : rawR;
      return {
        ...b,
        kind: "dot",
        axes: opts.axes,
        radius: radiusPx,
        glow: opts.glow ?? true,
        label: opts.label ?? "",
        labelOffset: opts.labelOffset,
        traceEnabled: Boolean(opts.trace),
        traceColor: opts.traceColor ?? b.color,
        trail: [],
        _curveSegments: [],
      };
    },

    Circle(
      opts: CommonOpts & {
        r?: number;
        radius?: number;
        fill?: string;
        width?: number;
        label?: string;
        dashed?: boolean;
      } = {}
    ): CircleMobject {
      const b = base("circle", opts, COLORS.cyan);
      return {
        ...b,
        kind: "circle",
        r: opts.r ?? opts.radius ?? 0.12,
        fill: opts.fill,
        width: opts.width ?? 2.2,
        label: opts.label ?? "",
        dashed: Boolean(opts.dashed),
      };
    },

    Rect(
      opts: CommonOpts & {
        w?: number;
        h?: number;
        radius?: number;
        fill?: string;
        width?: number;
        label?: string;
        dashed?: boolean;
      } = {}
    ): RectMobject {
      const b = base("rect", opts, COLORS.emerald);
      return {
        ...b,
        kind: "rect",
        w: opts.w ?? 0.22,
        h: opts.h ?? 0.14,
        radius: opts.radius ?? 8,
        fill: opts.fill,
        width: opts.width ?? 2.1,
        label: opts.label ?? "",
        dashed: Boolean(opts.dashed),
      };
    },

    RoundedRect(
      opts: CommonOpts & {
        w?: number;
        h?: number;
        radius?: number;
        fill?: string;
        width?: number;
        label?: string;
        dashed?: boolean;
      } = {}
    ): RectMobject {
      const b = base("rect", opts, COLORS.emerald);
      return {
        ...b,
        kind: "rect",
        w: opts.w ?? 0.22,
        h: opts.h ?? 0.14,
        radius: opts.radius ?? 14,
        fill: opts.fill,
        width: opts.width ?? 2.1,
        label: opts.label ?? "",
        dashed: Boolean(opts.dashed),
      };
    },

    Polygon(
      opts: CommonOpts & {
        points?: Vec2[];
        axes?: AxesMobject;
        fill?: string;
        width?: number;
        label?: string;
        closed?: boolean;
      } = {}
    ): PolygonMobject {
      const b = base("polygon", { x: 0, y: 0, ...opts }, COLORS.purple);
      return {
        ...b,
        kind: "polygon",
        points: opts.points ?? [
          [0.5, 0.35],
          [0.62, 0.62],
          [0.38, 0.62],
        ],
        axes: opts.axes,
        fill: opts.fill,
        width: opts.width ?? 2.2,
        label: opts.label ?? "",
        closed: opts.closed ?? true,
      };
    },

    Arc(
      opts: CommonOpts & {
        r?: number;
        radius?: number;
        startAngle?: number;
        endAngle?: number;
        width?: number;
        label?: string;
        dashed?: boolean;
      } = {}
    ): ArcMobject {
      const b = base("arc", opts, COLORS.amber);
      return {
        ...b,
        kind: "arc",
        r: opts.r ?? opts.radius ?? 0.12,
        startAngle: opts.startAngle ?? 0,
        endAngle: opts.endAngle ?? Math.PI,
        width: opts.width ?? 2.4,
        label: opts.label ?? "",
        dashed: Boolean(opts.dashed),
      };
    },

    Line(
      opts: CommonOpts & {
        from?: EndpointRef;
        to?: EndpointRef;
        axes?: AxesMobject;
        width?: number;
        dashed?: boolean;
        label?: string;
      } = {}
    ): LineMobject {
      const b = base("line", { x: 0, y: 0, ...opts }, COLORS.white);
      return {
        ...b,
        kind: "line",
        from: opts.from ?? [0.25, 0.5],
        to: opts.to ?? [0.75, 0.5],
        axes: opts.axes,
        width: opts.width ?? 2.1,
        dashed: Boolean(opts.dashed),
        label: opts.label ?? "",
      };
    },

    DashedLine(
      opts: CommonOpts & {
        from?: EndpointRef;
        to?: EndpointRef;
        axes?: AxesMobject;
        width?: number;
        label?: string;
      } = {}
    ): LineMobject {
      const b = base("line", { x: 0, y: 0, ...opts }, COLORS.muted);
      return {
        ...b,
        kind: "line",
        from: opts.from ?? [0.25, 0.5],
        to: opts.to ?? [0.75, 0.5],
        axes: opts.axes,
        width: opts.width ?? 1.8,
        dashed: true,
        label: opts.label ?? "",
      };
    },

    Arrow(
      opts: CommonOpts & {
        from?: EndpointRef;
        to?: EndpointRef;
        axes?: AxesMobject;
        width?: number;
        headSize?: number;
        dashed?: boolean;
        label?: string;
      } = {}
    ): ArrowMobject {
      const b = base("arrow", { x: 0, y: 0, ...opts }, COLORS.amber);
      return {
        ...b,
        kind: "arrow",
        from: opts.from ?? (opts.axes ? [0, 0] : [0.3, 0.5]),
        to: opts.to ?? (opts.axes ? [1, 1] : [0.7, 0.5]),
        axes: opts.axes,
        width: opts.width ?? 2.6,
        headSize: opts.headSize ?? 11,
        dashed: Boolean(opts.dashed),
        label: opts.label ?? "",
      };
    },

    Vector(
      opts: CommonOpts & {
        from?: EndpointRef;
        to?: EndpointRef;
        dir?: Vec2;
        axes?: AxesMobject;
        width?: number;
        headSize?: number;
        dashed?: boolean;
        label?: string;
      } = {}
    ): ArrowMobject {
      const from: EndpointRef = opts.from ?? (opts.axes ? [0, 0] : [0.5, 0.5]);
      const to: EndpointRef =
        opts.to ??
        (opts.dir && Array.isArray(from)
          ? [from[0] + opts.dir[0], from[1] + opts.dir[1]]
          : opts.axes
            ? [1, 1]
            : [0.7, 0.4]);
      const b = base("arrow", { x: 0, y: 0, ...opts }, COLORS.amber);
      return {
        ...b,
        kind: "arrow",
        from,
        to,
        axes: opts.axes,
        width: opts.width ?? 2.6,
        headSize: opts.headSize ?? 11,
        dashed: Boolean(opts.dashed),
        label: opts.label ?? "",
      };
    },

    Node(
      opts: CommonOpts & {
        r?: number;
        radius?: number;
        label?: string;
        sublabel?: string;
        shape?: "circle" | "rounded" | "box" | "diamond" | "hexagon";
        fill?: string;
        width?: number;
      } = {}
    ): NodeMobject {
      const b = base("node", opts, COLORS.cyan);
      return {
        ...b,
        kind: "node",
        r: opts.r ?? opts.radius ?? 0.052,
        label: opts.label ?? "",
        sublabel: opts.sublabel ?? "",
        shape: opts.shape ?? "circle",
        fill: opts.fill,
        width: opts.width ?? 2.2,
      };
    },

    Edge(
      opts: CommonOpts & {
        from?: EndpointRef;
        to?: EndpointRef;
        width?: number;
        label?: string;
        curved?: boolean | number;
        arrow?: boolean;
        dashed?: boolean;
      } = {}
    ): EdgeMobject {
      const b = base("edge", { x: 0, y: 0, ...opts }, COLORS.muted);
      const curvedVal =
        typeof opts.curved === "number" ? opts.curved : opts.curved ? 0.14 : 0;
      return {
        ...b,
        kind: "edge",
        from: opts.from ?? [0.25, 0.5],
        to: opts.to ?? [0.75, 0.5],
        width: opts.width ?? 1.8,
        label: opts.label ?? "",
        curved: curvedVal,
        arrow: Boolean(opts.arrow),
        dashed: Boolean(opts.dashed),
      };
    },

    BarChart(
      opts: CommonOpts & {
        w?: number;
        h?: number;
        labels?: string[];
        values?: number[];
        maxVal?: number;
        colors?: string[];
        title?: string;
        showValues?: boolean;
        unit?: string;
      } = {}
    ): BarChartMobject {
      const b = base("barchart", { x: 0.5, y: 0.55, ...opts }, COLORS.emerald);
      return {
        ...b,
        kind: "barchart",
        w: opts.w ?? 0.48,
        h: opts.h ?? 0.42,
        labels: opts.labels ?? ["A", "B", "C"],
        values: [...(opts.values ?? [60, 85, 45])],
        maxVal: opts.maxVal,
        colors: opts.colors,
        title: opts.title ?? "",
        showValues: opts.showValues ?? true,
        unit: opts.unit ?? "",
      };
    },

    Spring(
      opts: CommonOpts & {
        from?: EndpointRef;
        to?: EndpointRef;
        coils?: number;
        amplitude?: number;
        width?: number;
        label?: string;
      } = {}
    ): SpringMobject {
      const b = base("spring", { x: 0, y: 0, ...opts }, COLORS.cyan);
      return {
        ...b,
        kind: "spring",
        from: opts.from ?? [0.25, 0.5],
        to: opts.to ?? [0.75, 0.5],
        coils: opts.coils ?? 10,
        amplitude: opts.amplitude ?? 9,
        width: opts.width ?? 2.2,
        label: opts.label ?? "",
      };
    },

    Text(
      textOrOpts:
        | string
        | (CommonOpts & {
            text: string;
            size?: number;
            align?: CanvasTextAlign;
            weight?: string;
            font?: string;
            bg?: boolean | string;
            padding?: number;
            maxWidth?: number;
          }),
      maybeOpts: CommonOpts & {
        size?: number;
        align?: CanvasTextAlign;
        weight?: string;
        font?: string;
        bg?: boolean | string;
        padding?: number;
        maxWidth?: number;
      } = {}
    ): TextMobject {
      const text = typeof textOrOpts === "string" ? textOrOpts : textOrOpts.text;
      const opts = typeof textOrOpts === "string" ? maybeOpts : textOrOpts;
      const b = base("text", { x: 0.5, y: 0.12, ...opts }, COLORS.white);
      return {
        ...b,
        kind: "text",
        text: text ?? "",
        size: opts.size ?? 16,
        align: opts.align ?? "center",
        weight: opts.weight ?? "600",
        font: opts.font,
        bg: opts.bg ?? false,
        padding: opts.padding ?? 8,
        maxWidth: opts.maxWidth,
      };
    },

    MathTex(
      latexOrOpts:
        | string
        | (CommonOpts & {
            latex: string;
            size?: number;
            bg?: boolean | string;
            displayMode?: boolean;
            align?: "left" | "center" | "right";
          }),
      maybeOpts: CommonOpts & {
        size?: number;
        bg?: boolean | string;
        displayMode?: boolean;
        align?: "left" | "center" | "right";
      } = {}
    ): MathTexMobject {
      const latex = typeof latexOrOpts === "string" ? latexOrOpts : latexOrOpts.latex;
      const opts = typeof latexOrOpts === "string" ? maybeOpts : latexOrOpts;
      const b = base("mathtex", { x: 0.5, y: 0.14, ...opts }, COLORS.white);
      const tex: MathTexMobject = {
        ...b,
        kind: "mathtex",
        latex: latex ?? "",
        size: opts.size ?? 19,
        bg: opts.bg ?? false,
        displayMode: Boolean(opts.displayMode),
        align: opts.align ?? "center",
        setTex(nextLatex: string) {
          tex.latex = nextLatex;
        },
      };
      return tex;
    },
  };
}

/* ============================================================================
 * CANVAS2D RENDERERS (3Blue1Brown-grade Obsidian Aesthetic)
 * ============================================================================ */

function drawStageBackground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  // Deep obsidian base
  ctx.fillStyle = "#080c14";
  ctx.fillRect(0, 0, W, H);

  // Subtle top-center studio nebula bloom (3b1b ambient slate-cyan wash)
  const rad = Math.max(W, H) * 0.78;
  const g = ctx.createRadialGradient(W * 0.5, H * 0.42, rad * 0.04, W * 0.5, H * 0.5, rad);
  g.addColorStop(0, "rgba(30, 58, 95, 0.22)");
  g.addColorStop(0.48, "rgba(12, 20, 34, 0.12)");
  g.addColorStop(1, "rgba(3, 5, 10, 0.72)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Very subtle architectural corner vignette
  const vig = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.34, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.46)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
}

function renderAxes(
  ctx: CanvasRenderingContext2D,
  ax: AxesMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(ax.drawProgress, 0, 1);
  if (ax.opacity <= 0.004 || dp <= 0.004) return;

  const left = (ax.x - ax.w * 0.5) * W;
  const right = (ax.x + ax.w * 0.5) * W;
  const top = (ax.y - ax.h * 0.5) * H;
  const bottom = (ax.y + ax.h * 0.5) * H;

  const [xMin, xMax] = ax.xRange;
  const [yMin, yMax] = ax.yRange;
  const xStep = ax.xStep ?? niceStep(xMax - xMin, 7);
  const yStep = ax.yStep ?? niceStep(yMax - yMin, 5);

  const [origXRaw, origYRaw] = ax.toPx(0, 0, W, H);
  const axisY = clamp(origYRaw, top, bottom);
  const axisX = clamp(origXRaw, left, right);

  ctx.save();
  ctx.globalAlpha = clamp(ax.opacity, 0, 1);

  // Subtle dark coordinate plane backdrop tint
  if (ax.grid) {
    ctx.fillStyle = "rgba(15, 23, 42, 0.28)";
    roundedRectPath(ctx, left - 4, top - 4, right - left + 8, bottom - top + 8, 8);
    ctx.fill();
  }

  // 1. Grid lines (reveal 0..0.65)
  const gridP = clamp(dp / 0.65, 0, 1);
  if (ax.grid && gridP > 0) {
    ctx.save();
    ctx.strokeStyle = ax.gridColor;
    ctx.lineWidth = ax.isPlane ? 1.1 : 1;
    ctx.globalAlpha *= gridP;

    const firstX = Math.ceil(xMin / xStep) * xStep;
    for (let x = firstX; x <= xMax + 1e-6; x += xStep) {
      const [px] = ax.toPx(x, 0, W, H);
      if (px < left - 1 || px > right + 1) continue;
      ctx.beginPath();
      ctx.moveTo(px, lerp(axisY, top, gridP));
      ctx.lineTo(px, lerp(axisY, bottom, gridP));
      ctx.stroke();
    }

    const firstY = Math.ceil(yMin / yStep) * yStep;
    for (let y = firstY; y <= yMax + 1e-6; y += yStep) {
      const [, py] = ax.toPx(0, y, W, H);
      if (py < top - 1 || py > bottom + 1) continue;
      ctx.beginPath();
      ctx.moveTo(lerp(axisX, left, gridP), py);
      ctx.lineTo(lerp(axisX, right, gridP), py);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2. Principal X & Y axes with arrowheads (reveal 0.12..0.88)
  const axisP = clamp((dp - 0.1) / 0.75, 0, 1);
  if (axisP > 0) {
    const xStart = lerp(axisX, left, axisP);
    const xEnd = lerp(axisX, right + 8, axisP);
    const yStart = lerp(axisY, bottom, axisP);
    const yEnd = lerp(axisY, top - 8, axisP);

    ctx.save();
    ctx.strokeStyle = withAlpha(ax.color, 0.85);
    ctx.lineWidth = 1.7;
    ctx.lineCap = "round";

    // X-axis
    ctx.beginPath();
    ctx.moveTo(xStart, axisY);
    ctx.lineTo(xEnd, axisY);
    ctx.stroke();

    // Y-axis
    ctx.beginPath();
    ctx.moveTo(axisX, yStart);
    ctx.lineTo(axisX, yEnd);
    ctx.stroke();

    if (axisP > 0.65) {
      const headAlpha = clamp((axisP - 0.65) / 0.35, 0, 1);
      const headColor = withAlpha(ax.color, 0.9 * headAlpha);
      drawArrowHead(ctx, xEnd + 2, axisY, 0, 8.5, headColor);
      drawArrowHead(ctx, axisX, yEnd - 2, -Math.PI / 2, 8.5, headColor);
    }
    ctx.restore();
  }

  // 3. Ticks & numeric labels (reveal 0.55..1.0)
  const tickP = clamp((dp - 0.52) / 0.48, 0, 1);
  if (tickP > 0) {
    ctx.save();
    ctx.globalAlpha *= tickP;
    const tickFont = Math.max(9, Math.round(10.5 * fontScale));
    ctx.font = `500 ${tickFont}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.fillStyle = withAlpha(ax.color, 0.78);
    ctx.strokeStyle = withAlpha(ax.color, 0.65);
    ctx.lineWidth = 1.2;

    if (ax.showTicks || ax.showNumbers) {
      const firstX = Math.ceil(xMin / xStep) * xStep;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let x = firstX; x <= xMax + 1e-6; x += xStep) {
        if (Math.abs(x) < 1e-6) continue;
        const [px] = ax.toPx(x, 0, W, H);
        if (px < left + 2 || px > right - 4) continue;
        if (ax.showTicks) {
          ctx.beginPath();
          ctx.moveTo(px, axisY - 3.5);
          ctx.lineTo(px, axisY + 3.5);
          ctx.stroke();
        }
        if (ax.showNumbers) {
          ctx.fillText(formatTick(x), px, axisY + 7);
        }
      }

      const firstY = Math.ceil(yMin / yStep) * yStep;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let y = firstY; y <= yMax + 1e-6; y += yStep) {
        if (Math.abs(y) < 1e-6) continue;
        const [, py] = ax.toPx(0, y, W, H);
        if (py < top + 4 || py > bottom - 2) continue;
        if (ax.showTicks) {
          ctx.beginPath();
          ctx.moveTo(axisX - 3.5, py);
          ctx.lineTo(axisX + 3.5, py);
          ctx.stroke();
        }
        if (ax.showNumbers) {
          ctx.fillText(formatTick(y), axisX - 7, py);
        }
      }
    }

    // Axis title labels
    const labelFont = Math.max(11, Math.round(12.5 * fontScale));
    ctx.font = `italic 600 ${labelFont}px "Georgia", "Times New Roman", serif`;
    ctx.fillStyle = COLORS.white;
    if (ax.xLabel) {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(ax.xLabel, right + 14, axisY);
    }
    if (ax.yLabel) {
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(ax.yLabel, axisX, top - 14);
    }

    ctx.restore();
  }

  ctx.restore();
}

function renderPlot(
  ctx: CanvasRenderingContext2D,
  plot: PlotMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(plot.drawProgress, 0, 1);
  if (plot.opacity <= 0.004 || dp <= 0.004) return;

  const ax = plot.axes;
  const [dMin, dMax] = plot.domain ?? ax.xRange;
  const [yMin, yMax] = ax.yRange;
  const yJumpLimit = Math.max(1, (yMax - yMin) * 3.5);
  const samples = Math.max(24, plot.samples);

  const left = (ax.x - ax.w * 0.5) * W;
  const right = (ax.x + ax.w * 0.5) * W;
  const top = (ax.y - ax.h * 0.5) * H;
  const bottom = (ax.y + ax.h * 0.5) * H;
  const [, zeroYPx] = ax.toPx(0, 0, W, H);
  const baselineY = clamp(zeroYPx, top, bottom);

  // Sample progressive curve segments up to dp
  const exactMaxIdx = dp * samples;
  const fullSteps = Math.floor(exactMaxIdx);
  const frac = exactMaxIdx - fullSteps;

  const segments: Array<Array<Vec2>> = [];
  let currentSeg: Array<Vec2> = [];
  let prevMathY: number | null = null;

  const pushSample = (mx: number) => {
    let my: number;
    try {
      my = plot.fn(mx);
    } catch {
      my = NaN;
    }
    if (!Number.isFinite(my)) {
      if (currentSeg.length > 0) {
        segments.push(currentSeg);
        currentSeg = [];
      }
      prevMathY = null;
      return;
    }
    if (prevMathY !== null && Math.abs(my - prevMathY) > yJumpLimit) {
      if (currentSeg.length > 0) {
        segments.push(currentSeg);
        currentSeg = [];
      }
    }
    const pt = ax.toPx(mx, my, W, H);
    currentSeg.push(pt);
    prevMathY = my;
  };

  for (let i = 0; i <= fullSteps; i++) {
    const t = i / samples;
    pushSample(lerp(dMin, dMax, t));
  }
  if (frac > 1e-4 && fullSteps < samples) {
    const t = (fullSteps + frac) / samples;
    pushSample(lerp(dMin, dMax, t));
  }
  if (currentSeg.length > 0) {
    segments.push(currentSeg);
  }

  const lastSeg = segments.length > 0 ? segments[segments.length - 1] : null;
  const lastTip: Vec2 | null = lastSeg && lastSeg.length > 0 ? lastSeg[lastSeg.length - 1] : null;

  ctx.save();
  ctx.globalAlpha = clamp(plot.opacity, 0, 1);

  // Soft clip to axes bounds (with generous stroke margin)
  ctx.save();
  ctx.beginPath();
  ctx.rect(left - 8, top - 12, right - left + 16, bottom - top + 24);
  ctx.clip();

  // Optional translucent area fill under curve
  if (plot.fillUnder) {
    const fillBase = typeof plot.fillUnder === "string" ? plot.fillUnder : plot.color;
    const fillGrad = ctx.createLinearGradient(0, top, 0, bottom);
    fillGrad.addColorStop(0, withAlpha(fillBase, 0.26));
    fillGrad.addColorStop(1, withAlpha(fillBase, 0.01));
    ctx.fillStyle = fillGrad;
    for (const seg of segments) {
      if (seg.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(seg[0][0], baselineY);
      for (let i = 0; i < seg.length; i++) {
        ctx.lineTo(seg[i][0], seg[i][1]);
      }
      ctx.lineTo(seg[seg.length - 1][0], baselineY);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Luminous glowing curve stroke
  ctx.strokeStyle = plot.color;
  ctx.lineWidth = plot.width * plot.scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (plot.dashed) {
    ctx.setLineDash([7, 5]);
  }
  ctx.shadowColor = withAlpha(plot.color, 0.78);
  ctx.shadowBlur = 12 * plot.glowIntensity;

  for (const seg of segments) {
    if (seg.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(seg[0][0], seg[0][1]);
    for (let i = 1; i < seg.length; i++) {
      ctx.lineTo(seg[i][0], seg[i][1]);
    }
    ctx.stroke();
  }

  // Crisp bright inner core stroke for 3b1b razor clarity
  ctx.shadowBlur = 0;
  ctx.strokeStyle = withAlpha("#ffffff", 0.35);
  ctx.lineWidth = Math.max(1, plot.width * 0.4);
  for (const seg of segments) {
    if (seg.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(seg[0][0], seg[0][1]);
    for (let i = 1; i < seg.length; i++) {
      ctx.lineTo(seg[i][0], seg[i][1]);
    }
    ctx.stroke();
  }

  // Leading drawing spark while animating drawProgress
  if (lastTip && dp > 0.02 && dp < 0.992) {
    const [tx, ty] = lastTip;
    const sparkGrad = ctx.createRadialGradient(tx, ty, 0, tx, ty, 10);
    sparkGrad.addColorStop(0, "#ffffff");
    sparkGrad.addColorStop(0.35, withAlpha(plot.color, 0.9));
    sparkGrad.addColorStop(1, withAlpha(plot.color, 0));
    ctx.fillStyle = sparkGrad;
    ctx.beginPath();
    ctx.arc(tx, ty, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // Optional curve label near end of curve
  if (plot.label && dp > 0.72 && lastTip) {
    const lblAlpha = clamp((dp - 0.72) / 0.28, 0, 1);
    ctx.save();
    ctx.globalAlpha *= lblAlpha;
    const fs = Math.max(11, Math.round(12 * fontScale));
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = plot.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 6;
    ctx.fillText(plot.label, clamp(lastTip[0] + 8, left + 8, right - 60), clamp(lastTip[1] - 12, top + 12, bottom - 12));
    ctx.restore();
  }

  ctx.restore();
}

function renderDot(
  ctx: CanvasRenderingContext2D,
  dot: DotMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(dot.drawProgress, 0, 1);
  if (dot.opacity <= 0.004 || dp <= 0.004) return;

  ctx.save();
  ctx.globalAlpha = clamp(dot.opacity, 0, 1);

  // 1. Deterministic traced curve trail (from moveAlongCurve segments)
  if (dot.traceEnabled && dot._curveSegments.length > 0) {
    for (const seg of dot._curveSegments) {
      if (seg.p <= 0.001) continue;
      const steps = Math.max(12, Math.round(56 * seg.p));
      const xEnd = lerp(seg.x0, seg.x1, seg.p);
      ctx.save();
      ctx.strokeStyle = seg.color || dot.traceColor || dot.color;
      ctx.lineWidth = 3.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = withAlpha(seg.color || dot.traceColor || dot.color, 0.85);
      ctx.shadowBlur = 12;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= steps; i++) {
        const mx = lerp(seg.x0, xEnd, i / steps);
        const my = seg.fn(mx);
        if (!Number.isFinite(my)) continue;
        const [px, py] = seg.axes.toPx(mx, my, W, H);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      if (started) ctx.stroke();
      ctx.restore();
    }
  }

  // 2. Arbitrary motion trail (for moveTo / shift when tracePath enabled)
  if (dot.traceEnabled && dot.trail.length >= 2) {
    ctx.save();
    ctx.strokeStyle = dot.traceColor || dot.color;
    ctx.lineWidth = 2.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = withAlpha(dot.traceColor || dot.color, 0.8);
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(dot.trail[0].x * W, dot.trail[0].y * H);
    for (let i = 1; i < dot.trail.length; i++) {
      ctx.lineTo(dot.trail[i].x * W, dot.trail[i].y * H);
    }
    ctx.stroke();
    ctx.restore();
  }

  const [px, py] = dot.axes ? dot.axes.toPx(dot.x, dot.y, W, H) : [dot.x * W, dot.y * H];
  const y = py + dot.offsetY;

  // Smooth elastic-like pop scale for drawProgress
  const pop = dp < 1 ? Math.sin((dp * Math.PI) / 2) * (1 + 0.14 * Math.sin(dp * Math.PI)) : 1;
  const r = Math.max(1.5, dot.radius * dot.scale * pop);

  // Outer ambient aura
  if (dot.glow) {
    const auraR = r * (2.6 + 0.8 * (dot.glowIntensity - 1));
    const aura = ctx.createRadialGradient(px, y, r * 0.25, px, y, auraR);
    aura.addColorStop(0, withAlpha(dot.color, 0.58));
    aura.addColorStop(0.5, withAlpha(dot.color, 0.18));
    aura.addColorStop(1, withAlpha(dot.color, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(px, y, auraR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Indicate pulse ring when glowing brightly
  if (dot.glowIntensity > 1.15) {
    const ringAlpha = clamp((dot.glowIntensity - 1.15) / 1.6, 0, 0.8);
    ctx.save();
    ctx.strokeStyle = withAlpha("#ffffff", ringAlpha * 0.75);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(px, y, r + 5 + (dot.glowIntensity - 1) * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Luminous orb with specular highlight
  const orb = ctx.createRadialGradient(px - r * 0.3, y - r * 0.3, r * 0.08, px, y, r);
  orb.addColorStop(0, "#ffffff");
  orb.addColorStop(0.38, dot.color);
  orb.addColorStop(1, withAlpha(dot.color, 0.92));
  ctx.fillStyle = orb;
  ctx.shadowColor = withAlpha(dot.color, 0.85);
  ctx.shadowBlur = (dot.glow ? 14 : 4) * dot.glowIntensity;
  ctx.beginPath();
  ctx.arc(px, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Optional crisp label
  if (dot.label) {
    const [ox, oy] = dot.labelOffset ?? [0, -(r + 14)];
    const fs = Math.max(10.5, Math.round(12 * fontScale));
    ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 6;
    ctx.fillText(dot.label, px + ox, y + oy);
  }

  ctx.restore();
}

function renderCircle(
  ctx: CanvasRenderingContext2D,
  obj: CircleMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(obj.drawProgress, 0, 1);
  if (obj.opacity <= 0.004 || dp <= 0.004) return;

  const cx = obj.x * W;
  const cy = obj.y * H + obj.offsetY;
  const r = resolveRadiusPx(obj.r, W, H);

  ctx.save();
  ctx.globalAlpha = clamp(obj.opacity, 0, 1);
  ctx.translate(cx, cy);
  ctx.rotate(obj.rotation);
  ctx.scale(obj.scale, obj.scale);

  if (obj.fill) {
    ctx.save();
    ctx.globalAlpha *= dp;
    ctx.fillStyle = obj.fill;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width;
  ctx.lineCap = "round";
  if (obj.dashed) ctx.setLineDash([6, 5]);
  ctx.shadowColor = withAlpha(obj.color, 0.72);
  ctx.shadowBlur = 10 * obj.glowIntensity;

  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dp);
  ctx.stroke();

  if (obj.label) {
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    const fs = Math.max(11, Math.round(12.5 * fontScale));
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(obj.label, 0, 0);
  }

  ctx.restore();
}

function renderRect(
  ctx: CanvasRenderingContext2D,
  obj: RectMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(obj.drawProgress, 0, 1);
  if (obj.opacity <= 0.004 || dp <= 0.004) return;

  const cx = obj.x * W;
  const cy = obj.y * H + obj.offsetY;
  const rw = resolveDimPx(obj.w, W);
  const rh = resolveDimPx(obj.h, H);

  ctx.save();
  ctx.globalAlpha = clamp(obj.opacity, 0, 1);
  ctx.translate(cx, cy);
  ctx.rotate(obj.rotation);
  ctx.scale(obj.scale, obj.scale);

  roundedRectPath(ctx, -rw / 2, -rh / 2, rw, rh, obj.radius);

  if (obj.fill) {
    ctx.save();
    ctx.globalAlpha *= dp;
    ctx.fillStyle = obj.fill;
    ctx.fill();
    ctx.restore();
  }

  const perim = 2 * (rw + rh);
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width;
  ctx.lineJoin = "round";
  ctx.shadowColor = withAlpha(obj.color, 0.7);
  ctx.shadowBlur = 10 * obj.glowIntensity;
  if (obj.dashed) {
    ctx.setLineDash([6, 5]);
  } else if (dp < 0.995) {
    ctx.setLineDash([perim * dp, perim + 4]);
  }
  ctx.stroke();

  if (obj.label) {
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    const fs = Math.max(11, Math.round(13 * fontScale));
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(obj.label, 0, 0);
  }

  ctx.restore();
}

function renderPolygon(
  ctx: CanvasRenderingContext2D,
  obj: PolygonMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(obj.drawProgress, 0, 1);
  if (obj.opacity <= 0.004 || dp <= 0.004 || obj.points.length < 2) return;

  const pts: Vec2[] = obj.points.map(([px, py]) =>
    obj.axes ? obj.axes.toPx(px, py, W, H) : [px * W, py * H]
  );

  // Centroid for rotation/scaling
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;

  ctx.save();
  ctx.globalAlpha = clamp(obj.opacity, 0, 1);
  ctx.translate(cx + obj.x * W, cy + obj.y * H + obj.offsetY);
  ctx.rotate(obj.rotation);
  ctx.scale(obj.scale, obj.scale);

  const localPts: Vec2[] = pts.map(([x, y]) => [x - cx, y - cy]);

  // Fill
  if (obj.fill && obj.closed && localPts.length >= 3) {
    ctx.save();
    ctx.globalAlpha *= dp;
    ctx.fillStyle = obj.fill;
    ctx.beginPath();
    ctx.moveTo(localPts[0][0], localPts[0][1]);
    for (let i = 1; i < localPts.length; i++) {
      ctx.lineTo(localPts[i][0], localPts[i][1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Progressive perimeter trace
  const edgePts = obj.closed ? [...localPts, localPts[0]] : localPts;
  let totalLen = 0;
  const segLens: number[] = [];
  for (let i = 0; i < edgePts.length - 1; i++) {
    const l = Math.hypot(edgePts[i + 1][0] - edgePts[i][0], edgePts[i + 1][1] - edgePts[i][1]);
    segLens.push(l);
    totalLen += l;
  }

  let remaining = totalLen * dp;
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.shadowColor = withAlpha(obj.color, 0.72);
  ctx.shadowBlur = 10 * obj.glowIntensity;
  ctx.beginPath();
  ctx.moveTo(edgePts[0][0], edgePts[0][1]);
  for (let i = 0; i < segLens.length && remaining > 0; i++) {
    const l = segLens[i];
    if (remaining >= l || l <= 1e-6) {
      ctx.lineTo(edgePts[i + 1][0], edgePts[i + 1][1]);
      remaining -= l;
    } else {
      const f = remaining / l;
      ctx.lineTo(lerp(edgePts[i][0], edgePts[i + 1][0], f), lerp(edgePts[i][1], edgePts[i + 1][1], f));
      remaining = 0;
    }
  }
  ctx.stroke();

  if (obj.label) {
    ctx.shadowBlur = 0;
    const fs = Math.max(11, Math.round(12.5 * fontScale));
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(obj.label, 0, 0);
  }

  ctx.restore();
}

function renderArc(
  ctx: CanvasRenderingContext2D,
  obj: ArcMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(obj.drawProgress, 0, 1);
  if (obj.opacity <= 0.004 || dp <= 0.004) return;

  const cx = obj.x * W;
  const cy = obj.y * H + obj.offsetY;
  const r = resolveRadiusPx(obj.r, W, H);
  const currentEnd = lerp(obj.startAngle, obj.endAngle, dp);
  const anticlockwise = obj.endAngle < obj.startAngle;

  ctx.save();
  ctx.globalAlpha = clamp(obj.opacity, 0, 1);
  ctx.translate(cx, cy);
  ctx.rotate(obj.rotation);
  ctx.scale(obj.scale, obj.scale);

  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width;
  ctx.lineCap = "round";
  if (obj.dashed) ctx.setLineDash([6, 5]);
  ctx.shadowColor = withAlpha(obj.color, 0.72);
  ctx.shadowBlur = 10 * obj.glowIntensity;
  ctx.beginPath();
  ctx.arc(0, 0, r, obj.startAngle, currentEnd, anticlockwise);
  ctx.stroke();

  if (obj.label && dp > 0.5) {
    const midA = (obj.startAngle + obj.endAngle) * 0.5;
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    const fs = Math.max(10.5, Math.round(12 * fontScale));
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = obj.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(obj.label, Math.cos(midA) * (r + 16), Math.sin(midA) * (r + 16));
  }

  ctx.restore();
}

function renderLine(
  ctx: CanvasRenderingContext2D,
  obj: LineMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(obj.drawProgress, 0, 1);
  if (obj.opacity <= 0.004 || dp <= 0.004) return;

  const p1 = endpointToPx(obj.from, W, H, obj.axes);
  const p2 = endpointToPx(obj.to, W, H, obj.axes);
  const rawDx = p2.x - p1.x;
  const rawDy = p2.y - p1.y;
  const rawDist = Math.hypot(rawDx, rawDy) || 1;
  const trim1 = Math.min(p1.trimR, rawDist * 0.42);
  const trim2 = Math.min(p2.trimR, rawDist * 0.42);
  const x1 = p1.x + (rawDx / rawDist) * trim1;
  const y1 = p1.y + (rawDy / rawDist) * trim1;
  const x2 = p2.x - (rawDx / rawDist) * trim2;
  const y2 = p2.y - (rawDy / rawDist) * trim2;

  const ox = obj.x * W;
  const oy = obj.y * H + obj.offsetY;
  const sx = x1 + ox;
  const sy = y1 + oy;
  const ex = lerp(x1, x2, dp) + ox;
  const ey = lerp(y1, y2, dp) + oy;

  ctx.save();
  ctx.globalAlpha = clamp(obj.opacity, 0, 1);
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width * obj.scale;
  ctx.lineCap = "round";
  if (obj.dashed) ctx.setLineDash([6, 5]);
  ctx.shadowColor = withAlpha(obj.color, 0.65);
  ctx.shadowBlur = 8 * obj.glowIntensity;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  if (obj.label && dp > 0.5) {
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    const mx = (sx + ex) * 0.5;
    const my = (sy + ey) * 0.5;
    const angle = Math.atan2(ey - sy, ex - sx);
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    const fs = Math.max(10.5, Math.round(12 * fontScale));
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = obj.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(obj.label, mx + nx * 14, my + ny * 14);
  }

  ctx.restore();
}

function renderArrow(
  ctx: CanvasRenderingContext2D,
  obj: ArrowMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(obj.drawProgress, 0, 1);
  if (obj.opacity <= 0.004 || dp <= 0.004) return;

  const p1 = endpointToPx(obj.from, W, H, obj.axes);
  const p2 = endpointToPx(obj.to, W, H, obj.axes);
  const rawDx = p2.x - p1.x;
  const rawDy = p2.y - p1.y;
  const rawDist = Math.hypot(rawDx, rawDy) || 1;
  const trim1 = Math.min(p1.trimR, rawDist * 0.42);
  const trim2 = Math.min(p2.trimR, rawDist * 0.42);
  const x1 = p1.x + (rawDx / rawDist) * trim1;
  const y1 = p1.y + (rawDy / rawDist) * trim1;
  const x2 = p2.x - (rawDx / rawDist) * trim2;
  const y2 = p2.y - (rawDy / rawDist) * trim2;

  const ox = obj.x * W;
  const oy = obj.y * H + obj.offsetY;
  const sx = x1 + ox;
  const sy = y1 + oy;
  const ex = lerp(x1, x2, dp) + ox;
  const ey = lerp(y1, y2, dp) + oy;

  const dist = Math.hypot(ex - sx, ey - sy);
  if (dist < 2) return;

  const lengthFade = clamp((dist - 2) / 14, 0, 1);
  const angle = Math.atan2(ey - sy, ex - sx);
  const headSize = Math.min(obj.headSize * obj.scale, dist * 0.55);

  ctx.save();
  ctx.globalAlpha = clamp(obj.opacity * lengthFade, 0, 1);

  // Pull shaft end slightly back so it doesn't poke past the chevron tip
  const shaftEndX = ex - Math.cos(angle) * (headSize * 0.65);
  const shaftEndY = ey - Math.sin(angle) * (headSize * 0.65);

  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width * obj.scale;
  ctx.lineCap = "round";
  if (obj.dashed) ctx.setLineDash([6, 4]);
  ctx.shadowColor = withAlpha(obj.color, 0.8);
  ctx.shadowBlur = 11 * obj.glowIntensity;

  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(shaftEndX, shaftEndY);
  ctx.stroke();

  ctx.setLineDash([]);
  drawArrowHead(ctx, ex, ey, angle, headSize, obj.color);

  if (obj.label && dist > 18) {
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 6;
    const mx = (sx + ex) * 0.5;
    const my = (sy + ey) * 0.5;
    let nx = -Math.sin(angle);
    let ny = Math.cos(angle);
    // Keep label slightly above / outside the vector cleanly
    if (ny > 0.35) {
      nx = -nx;
      ny = -ny;
    }
    const fs = Math.max(10.5, Math.round(12 * fontScale));
    ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = obj.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(obj.label, mx + nx * 16, my + ny * 16);
  }

  ctx.restore();
}

function renderNode(
  ctx: CanvasRenderingContext2D,
  node: NodeMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(node.drawProgress, 0, 1);
  if (node.opacity <= 0.004 || dp <= 0.004) return;

  const cx = node.x * W;
  const cy = node.y * H + node.offsetY;
  const r = resolveRadiusPx(node.r, W, H);
  const pop = dp < 1 ? 0.55 + 0.45 * Math.sin((dp * Math.PI) / 2) : 1;

  ctx.save();
  ctx.globalAlpha = clamp(node.opacity, 0, 1);
  ctx.translate(cx, cy);
  ctx.rotate(node.rotation);
  ctx.scale(node.scale * pop, node.scale * pop);

  // Soft outer glow bloom (dramatically flares on indicate())
  const haloR = r * (1.7 + 0.55 * (node.glowIntensity - 1));
  const halo = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, haloR);
  halo.addColorStop(0, withAlpha(node.color, 0.24 * Math.min(2.4, node.glowIntensity)));
  halo.addColorStop(1, withAlpha(node.color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, haloR, 0, Math.PI * 2);
  ctx.fill();

  const traceNodeShape = () => {
    if (node.shape === "rounded" || node.shape === "box") {
      const rw = r * 2.2;
      const rh = r * 1.55;
      roundedRectPath(ctx, -rw / 2, -rh / 2, rw, rh, node.shape === "rounded" ? 12 : 3);
    } else if (node.shape === "diamond") {
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.15);
      ctx.lineTo(r * 1.15, 0);
      ctx.lineTo(0, r * 1.15);
      ctx.lineTo(-r * 1.15, 0);
      ctx.closePath();
    } else if (node.shape === "hexagon") {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const hx = Math.cos(a) * r * 1.08;
        const hy = Math.sin(a) * r * 1.08;
        if (i === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
      }
      ctx.closePath();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
  };

  // Deep obsidian tinted glass body
  traceNodeShape();
  const bodyGrad = ctx.createRadialGradient(-r * 0.25, -r * 0.28, r * 0.1, 0, 0, r * 1.15);
  bodyGrad.addColorStop(0, node.fill ?? withAlpha(node.color, 0.26));
  bodyGrad.addColorStop(0.65, "rgba(11, 18, 30, 0.92)");
  bodyGrad.addColorStop(1, "rgba(8, 12, 20, 0.98)");
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // Luminous progressive border
  ctx.strokeStyle = node.color;
  ctx.lineWidth = node.width;
  ctx.shadowColor = withAlpha(node.color, 0.85);
  ctx.shadowBlur = 11 * node.glowIntensity;
  if (node.shape === "circle" && dp < 0.995) {
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dp);
    ctx.stroke();
  } else {
    traceNodeShape();
    ctx.stroke();
  }

  // Extra activation flash ring when indicate() peaks
  if (node.glowIntensity > 1.2) {
    const pulseAlpha = clamp((node.glowIntensity - 1.2) / 1.5, 0, 0.85);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = withAlpha("#ffffff", pulseAlpha * 0.65);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, r + 4 + (node.glowIntensity - 1) * 3.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Centered label + sublabel
  ctx.shadowBlur = 0;
  const hasSub = Boolean(node.sublabel);
  const titleFs = Math.max(11, Math.round(Math.min(15, r * 0.62) * Math.max(0.85, fontScale)));
  const subFs = Math.max(8.5, Math.round(Math.min(10.5, r * 0.42) * Math.max(0.85, fontScale)));

  if (node.label) {
    ctx.font = `700 ${titleFs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(node.label, 0, hasSub ? -subFs * 0.48 : 0);
  }
  if (hasSub) {
    ctx.font = `600 ${subFs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = withAlpha(node.color, 0.95);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(node.sublabel, 0, titleFs * 0.56);
  }

  ctx.restore();
}

function renderEdge(
  ctx: CanvasRenderingContext2D,
  edge: EdgeMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(edge.drawProgress, 0, 1);
  if (edge.opacity <= 0.004 || dp <= 0.004) return;

  const geom = evalEdgeGeometry(edge.from, edge.to, edge.curved, W, H);
  const steps = geom.isCurved ? 36 : 2;

  ctx.save();
  ctx.globalAlpha = clamp(edge.opacity, 0, 1);
  ctx.strokeStyle = edge.color;
  ctx.lineWidth = edge.width * edge.scale;
  ctx.lineCap = "round";
  if (edge.dashed) ctx.setLineDash([5, 5]);
  ctx.shadowColor = withAlpha(edge.color, 0.5);
  ctx.shadowBlur = 6 * edge.glowIntensity;

  ctx.beginPath();
  const [sx, sy] = geom.pointAt(0);
  ctx.moveTo(sx, sy);
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * dp;
    const [px, py] = geom.pointAt(t);
    ctx.lineTo(px, py);
  }
  ctx.stroke();

  if (edge.arrow && dp > 0.25) {
    ctx.setLineDash([]);
    const [tx, ty] = geom.pointAt(dp);
    drawArrowHead(ctx, tx, ty, geom.tangentAt(dp), 8.5, edge.color);
  }

  if (edge.label && dp > 0.65) {
    const [mx, my] = geom.pointAt(0.5);
    const tan = geom.tangentAt(0.5);
    const nx = -Math.sin(tan);
    const ny = Math.cos(tan);
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    const fs = Math.max(9.5, Math.round(10.5 * fontScale));
    ctx.font = `600 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = withAlpha(edge.color, 0.92);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(edge.label, mx + nx * 11, my + ny * 11);
  }

  ctx.restore();
}

function renderPacket(ctx: CanvasRenderingContext2D, pkt: PacketState, W: number, H: number): void {
  if (pkt.opacity <= 0.005) return;

  let fromRef: EndpointRef;
  let toRef: EndpointRef;
  let curved = 0;

  if (Array.isArray(pkt.target)) {
    fromRef = pkt.target[0];
    toRef = pkt.target[1];
  } else if ("kind" in pkt.target && pkt.target.kind === "edge") {
    fromRef = pkt.target.from;
    toRef = pkt.target.to;
    curved = pkt.target.curved;
  } else {
    fromRef = pkt.target.from;
    toRef = pkt.target.to;
  }

  const geom = evalEdgeGeometry(fromRef, toRef, curved, W, H);
  const headT = clamp(pkt.t, 0, 1);
  const tailT = Math.max(0, headT - 0.24);

  ctx.save();
  ctx.globalAlpha = clamp(pkt.opacity, 0, 1);

  // Glowing comet tail along exact edge curve
  const tailSteps = 14;
  for (let i = 0; i < tailSteps; i++) {
    const f0 = i / tailSteps;
    const f1 = (i + 1) / tailSteps;
    const p0 = geom.pointAt(lerp(tailT, headT, f0));
    const p1 = geom.pointAt(lerp(tailT, headT, f1));
    ctx.strokeStyle = withAlpha(pkt.color, f1 * f1 * 0.85);
    ctx.lineWidth = Math.max(1, pkt.size * 0.85 * f1);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.stroke();
  }

  // Luminous photon head
  const [hx, hy] = geom.pointAt(headT);
  const halo = ctx.createRadialGradient(hx, hy, 0.5, hx, hy, pkt.size * 3.1);
  halo.addColorStop(0, "#ffffff");
  halo.addColorStop(0.28, withAlpha(pkt.color, 0.95));
  halo.addColorStop(0.65, withAlpha(pkt.color, 0.35));
  halo.addColorStop(1, withAlpha(pkt.color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(hx, hy, pkt.size * 3.1, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(hx, hy, pkt.size * 0.55, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function renderBarChart(
  ctx: CanvasRenderingContext2D,
  chart: BarChartMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(chart.drawProgress, 0, 1);
  if (chart.opacity <= 0.004 || dp <= 0.004) return;

  const cw = resolveDimPx(chart.w, W);
  const ch = resolveDimPx(chart.h, H);
  const cx = chart.x * W;
  const cy = chart.y * H + chart.offsetY;

  const n = Math.max(1, chart.values.length);
  const maxVal =
    chart.maxVal ?? Math.max(1, ...chart.values.map((v) => (Number.isFinite(v) ? v : 0))) * 1.15;

  const defaultColors = [
    COLORS.emerald,
    COLORS.cyan,
    COLORS.purple,
    COLORS.amber,
    COLORS.rose,
    COLORS.blue,
  ];

  ctx.save();
  ctx.globalAlpha = clamp(chart.opacity, 0, 1);
  ctx.translate(cx, cy);
  ctx.rotate(chart.rotation);
  ctx.scale(chart.scale, chart.scale);

  const left = -cw * 0.5;
  const top = -ch * 0.5;
  const padT = chart.title ? 24 : 16;
  const padB = 26;
  const padX = 12;
  const plotW = Math.max(24, cw - padX * 2);
  const plotH = Math.max(24, ch - padT - padB);
  const baseY = top + padT + plotH;

  // Sleek dark obsidian panel card
  ctx.fillStyle = "rgba(13, 20, 34, 0.72)";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, left, top, cw, ch, 10);
  ctx.fill();
  ctx.stroke();

  // Optional title
  if (chart.title) {
    const tFs = Math.max(10, Math.round(11 * fontScale));
    ctx.font = `700 ${tFs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(chart.title, 0, top + 7);
  }

  // Subtle horizontal reference gridlines
  ctx.strokeStyle = "rgba(148, 163, 184, 0.1)";
  ctx.lineWidth = 1;
  for (let g = 1; g <= 3; g++) {
    const gy = baseY - (plotH * g) / 3;
    ctx.beginPath();
    ctx.moveTo(left + padX, gy);
    ctx.lineTo(left + padX + plotW, gy);
    ctx.stroke();
  }

  // Baseline axis
  ctx.strokeStyle = "rgba(148, 163, 184, 0.42)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(left + padX, baseY);
  ctx.lineTo(left + padX + plotW, baseY);
  ctx.stroke();

  const slotW = plotW / n;
  const barW = Math.max(10, Math.min(44, slotW * 0.58));

  for (let i = 0; i < n; i++) {
    // Silky waterfall stagger across drawProgress
    const staggerSpan = Math.min(0.28, (n - 1) * 0.08);
    const barStart = n > 1 ? (i / (n - 1)) * staggerSpan : 0;
    const barP = clamp((dp - barStart) / Math.max(0.25, 1 - staggerSpan), 0, 1);
    const easedP = 1 - Math.pow(1 - barP, 3);

    const rawVal = Number.isFinite(chart.values[i]) ? Math.max(0, chart.values[i]) : 0;
    const displayVal = rawVal * easedP;
    const barH = clamp((displayVal / (maxVal || 1)) * plotH, 0, plotH);
    const bx = left + padX + slotW * (i + 0.5) - barW * 0.5;
    const by = baseY - barH;
    const col = chart.colors?.[i] ?? (n === 1 ? chart.color : defaultColors[i % defaultColors.length]);

    if (barH > 1) {
      const grad = ctx.createLinearGradient(0, by, 0, baseY);
      grad.addColorStop(0, col);
      grad.addColorStop(1, withAlpha(col, 0.28));

      ctx.save();
      ctx.fillStyle = grad;
      ctx.shadowColor = withAlpha(col, 0.65);
      ctx.shadowBlur = 10 * chart.glowIntensity;
      roundedRectPath(ctx, bx, by, barW, barH, Math.min(6, barW * 0.25, barH * 0.4));
      ctx.fill();

      // Bright top rim highlight
      ctx.shadowBlur = 0;
      ctx.fillStyle = withAlpha("#ffffff", 0.55);
      ctx.fillRect(bx + 2, by, Math.max(2, barW - 4), Math.min(2, barH));
      ctx.restore();
    }

    // Numeric value above bar
    if (chart.showValues && barP > 0.1) {
      const vFs = Math.max(9.5, Math.round(10.5 * fontScale));
      ctx.font = `700 ${vFs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = col;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const formatted =
        rawVal >= 10 || Math.abs(rawVal - Math.round(rawVal)) < 0.05
          ? `${Math.round(displayVal)}${chart.unit}`
          : `${displayVal.toFixed(2)}${chart.unit}`;
      ctx.fillText(formatted, bx + barW * 0.5, Math.max(top + padT - 2, by - 4));
    }

    // Bottom category label
    const lbl = chart.labels[i] ?? "";
    if (lbl) {
      const lFs = Math.max(9.5, Math.round(10.5 * fontScale));
      ctx.font = `600 ${lFs}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = COLORS.white;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(lbl, bx + barW * 0.5, baseY + 6);
    }
  }

  ctx.restore();
}

function renderSpring(
  ctx: CanvasRenderingContext2D,
  obj: SpringMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(obj.drawProgress, 0, 1);
  if (obj.opacity <= 0.004 || dp <= 0.004) return;

  const a = endpointToPx(obj.from, W, H);
  const b = endpointToPx(obj.to, W, H);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 4) return;

  const ux = dx / dist;
  const uy = dy / dist;
  const nx = -uy;
  const ny = ux;

  const lead = Math.min(14, dist * 0.14);
  const bodyLen = Math.max(4, dist - lead * 2);
  const coils = Math.max(2, Math.round(obj.coils));
  const amp = obj.amplitude * obj.scale;

  // Build spring polyline points
  const pts: Vec2[] = [[a.x, a.y], [a.x + ux * lead, a.y + uy * lead]];
  const zigSteps = coils * 2;
  for (let i = 1; i < zigSteps; i++) {
    const f = i / zigSteps;
    const along = lead + f * bodyLen;
    const side = i % 2 === 1 ? amp : -amp;
    pts.push([a.x + ux * along + nx * side, a.y + uy * along + ny * side]);
  }
  pts.push([b.x - ux * lead, b.y - uy * lead], [b.x, b.y]);

  // Progressive polyline draw
  const maxIdx = dp * (pts.length - 1);
  const whole = Math.floor(maxIdx);
  const frac = maxIdx - whole;

  ctx.save();
  ctx.globalAlpha = clamp(obj.opacity, 0, 1);
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width * obj.scale;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.shadowColor = withAlpha(obj.color, 0.72);
  ctx.shadowBlur = 9 * obj.glowIntensity;

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i <= whole; i++) {
    ctx.lineTo(pts[i][0], pts[i][1]);
  }
  if (frac > 1e-4 && whole < pts.length - 1) {
    ctx.lineTo(
      lerp(pts[whole][0], pts[whole + 1][0], frac),
      lerp(pts[whole][1], pts[whole + 1][1], frac)
    );
  }
  ctx.stroke();

  if (obj.label && dp > 0.6) {
    ctx.shadowBlur = 0;
    const mx = (a.x + b.x) * 0.5 + nx * (amp + 14);
    const my = (a.y + b.y) * 0.5 + ny * (amp + 14);
    const fs = Math.max(10.5, Math.round(12 * fontScale));
    ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = obj.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(obj.label, mx, my);
  }

  ctx.restore();
}

function renderText(
  ctx: CanvasRenderingContext2D,
  obj: TextMobject,
  W: number,
  H: number,
  fontScale: number
): void {
  const dp = clamp(obj.drawProgress, 0, 1);
  if (obj.opacity <= 0.004 || dp <= 0.004) return;

  const cx = obj.x * W;
  const cy = obj.y * H + obj.offsetY;
  const fs = Math.max(10, Math.round(obj.size * fontScale));
  const lines = String(obj.text).split("\n");
  const lineH = fs * 1.32;

  ctx.save();
  ctx.globalAlpha = clamp(obj.opacity * clamp(dp * 1.25, 0, 1), 0, 1);
  ctx.translate(cx, cy);
  ctx.rotate(obj.rotation);
  ctx.scale(obj.scale, obj.scale);

  ctx.font = `${obj.weight} ${fs}px ${obj.font ?? 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'}`;
  ctx.textAlign = obj.align;
  ctx.textBaseline = "middle";

  // Measure block for optional glass pill background
  let maxW = 0;
  for (const l of lines) {
    maxW = Math.max(maxW, ctx.measureText(l).width);
  }
  const totalH = lines.length * lineH;

  if (obj.bg) {
    const padX = obj.padding + 4;
    const padY = Math.max(4, obj.padding * 0.65);
    let rx = -maxW * 0.5 - padX;
    if (obj.align === "left") rx = -padX;
    else if (obj.align === "right") rx = -maxW - padX;

    ctx.fillStyle = typeof obj.bg === "string" ? obj.bg : "rgba(10, 16, 28, 0.82)";
    ctx.strokeStyle = withAlpha(obj.color, 0.35);
    ctx.lineWidth = 1;
    roundedRectPath(ctx, rx, -totalH * 0.5 - padY, maxW + padX * 2, totalH + padY * 2, 8);
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = obj.color;
  ctx.shadowColor = withAlpha(obj.color, 0.45 * obj.glowIntensity);
  ctx.shadowBlur = 8 * obj.glowIntensity;

  for (let i = 0; i < lines.length; i++) {
    const ly = (i - (lines.length - 1) / 2) * lineH;
    ctx.fillText(lines[i], 0, ly, obj.maxWidth);
  }

  ctx.restore();
}

function syncMathTexElement(
  obj: MathTexMobject,
  overlayLayer: HTMLDivElement,
  W: number,
  fontScale: number
): void {
  if (!obj._el) {
    const div = document.createElement("div");
    div.style.position = "absolute";
    div.style.pointerEvents = "none";
    div.style.userSelect = "none";
    div.style.whiteSpace = "nowrap";
    div.style.lineHeight = "1.15";
    div.style.transformOrigin = "center center";
    div.style.willChange = "transform, opacity";
    overlayLayer.appendChild(div);
    obj._el = div;
  }

  const el = obj._el;
  if (obj._renderedLatex !== obj.latex) {
    try {
      el.innerHTML = katex.renderToString(obj.latex, {
        throwOnError: false,
        displayMode: obj.displayMode,
        strict: false,
      });
    } catch {
      el.textContent = obj.latex;
    }
    obj._renderedLatex = obj.latex;
  }

  const dp = clamp(obj.drawProgress, 0, 1);
  const effOpacity = clamp(obj.opacity, 0, 1);
  if (effOpacity <= 0.005 || dp <= 0.005) {
    el.style.opacity = "0";
    el.style.visibility = "hidden";
    return;
  }

  el.style.visibility = "visible";
  el.style.opacity = effOpacity.toFixed(3);
  el.style.left = `${obj.x * 100}%`;
  el.style.top = `${obj.y * 100}%`;
  el.style.color = obj.color;
  el.style.fontSize = `${Math.max(11, Math.round(obj.size * fontScale))}px`;

  if (obj.bg) {
    el.style.background =
      typeof obj.bg === "string" ? obj.bg : "rgba(8, 13, 24, 0.82)";
    el.style.border = `1px solid ${withAlpha(obj.color, 0.34)}`;
    el.style.borderRadius = "10px";
    el.style.padding = `${Math.max(4, Math.round(5 * fontScale))}px ${Math.max(8, Math.round(11 * fontScale))}px`;
    el.style.boxShadow = `0 6px 22px rgba(0,0,0,0.48), 0 0 ${Math.round(14 * obj.glowIntensity)}px ${withAlpha(obj.color, 0.22 * obj.glowIntensity)}`;
    el.style.backdropFilter = "blur(8px)";
  } else {
    el.style.background = "transparent";
    el.style.border = "none";
    el.style.padding = "0";
    el.style.boxShadow = "none";
  }

  const glowPx = Math.round(12 * obj.glowIntensity);
  el.style.textShadow = `0 0 ${glowPx}px ${withAlpha(obj.color, 0.55)}, 0 2px 10px rgba(0,0,0,0.75)`;

  const txPct = obj.align === "left" ? "0%" : obj.align === "right" ? "-100%" : "-50%";
  const offsetYStr = obj.offsetY ? `${obj.offsetY.toFixed(2)}px` : "0px";
  const rotPart = Math.abs(obj.rotation) > 1e-4 ? ` rotate(${obj.rotation.toFixed(4)}rad)` : "";
  el.style.transform = `translate(${txPct}, calc(-50% + ${offsetYStr})) scale(${obj.scale.toFixed(4)})${rotPart}`;

  // Signature Manim left-to-right handwriting reveal while drawProgress < 1
  if (dp < 0.995) {
    const rightInset = ((1 - dp) * 100).toFixed(2);
    el.style.clipPath = `inset(-40% ${rightInset}% -40% -12%)`;
  } else {
    el.style.clipPath = "none";
  }

  // Ensure crisp layout bounds awareness
  void W;
}

/* ============================================================================
 * MAIN MOUNT ENTRYPOINT
 * ============================================================================ */

export function mountManimScene(opts: ManimMountOptions): ManimController {
  const { canvas, overlayLayer, code, onStateChange, onError } = opts;
  const ctx = canvas.getContext("2d");

  // Clean overlay container for fresh KaTeX nodes
  overlayLayer.innerHTML = "";

  const mobjects: AnyMobject[] = [];
  const packets: PacketState[] = [];
  const beats: ManimBeatInfo[] = [];

  const masterTl = gsap.timeline({ paused: true });
  const M = createMobjectFactory();

  let W = 640;
  let H = 440;
  let dpr = 1;
  let disposed = false;
  let rafId = 0;
  let resizeObserver: ResizeObserver | null = null;
  let lastEmitTs = 0;
  let lastPlaying = false;
  let lastBeatIdx = -1;

  const resize = () => {
    if (disposed) return;
    const host = canvas.parentElement || canvas;
    const rect = host.getBoundingClientRect();
    W = Math.max(rect.width || canvas.clientWidth || 640, 120);
    H = Math.max(rect.height || canvas.clientHeight || 420, 120);
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  };

  resize();

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      resize();
      renderFrame();
    });
    resizeObserver.observe(canvas.parentElement || canvas);
  }

  const ensureAdded = <T extends BaseMobject>(obj: T): T => {
    if (obj && !obj._added) {
      obj._added = true;
      mobjects.push(obj as unknown as AnyMobject);
    }
    return obj;
  };

  const clearTransientTrails = () => {
    for (const m of mobjects) {
      if (m.kind === "dot") {
        m.trail.length = 0;
        m._lastTrailPt = undefined;
      }
    }
  };

  const getTimelineDuration = (): number => Math.max(masterTl.duration(), 0.01);

  const isCurrentlyPlaying = (): boolean => {
    const dur = masterTl.duration();
    if (dur <= 0) return false;
    return !masterTl.paused() && masterTl.progress() < 0.9999;
  };

  const resolveActiveBeat = (t: number): { activeBeatIndex: number; subtitle: string } => {
    if (beats.length === 0) {
      return { activeBeatIndex: 0, subtitle: "" };
    }
    let active = beats[0];
    for (let i = 0; i < beats.length; i++) {
      if (t + 0.025 >= beats[i].startTime) {
        active = beats[i];
      } else {
        break;
      }
    }
    return { activeBeatIndex: active.index, subtitle: active.subtitle };
  };

  const emitState = (force = false) => {
    if (disposed || !onStateChange) return;
    const now = performance.now();
    const playing = isCurrentlyPlaying();
    const time = masterTl.time();
    const duration = getTimelineDuration();
    const { activeBeatIndex, subtitle } = resolveActiveBeat(time);

    if (
      !force &&
      playing === lastPlaying &&
      activeBeatIndex === lastBeatIdx &&
      now - lastEmitTs < 66
    ) {
      return;
    }

    lastEmitTs = now;
    lastPlaying = playing;
    lastBeatIdx = activeBeatIndex;

    onStateChange({
      playing,
      time,
      duration,
      activeBeatIndex,
      subtitle,
      beats: beats.map((b) => ({ ...b })),
    });
  };

  /* ==========================================================================
   * SCENE CHOREOGRAPHY API (`scene.*`)
   * ========================================================================== */

  const resolveTl = (tl?: gsap.core.Timeline | null): gsap.core.Timeline => tl || masterTl;

  const scene = {
    timeline: masterTl,

    add<T extends BaseMobject>(...objs: T[]): T {
      for (const o of objs) {
        if (o) ensureAdded(o);
      }
      return objs[0];
    },

    remove(obj: BaseMobject): void {
      const idx = mobjects.indexOf(obj as unknown as AnyMobject);
      if (idx !== -1) {
        const removed = mobjects.splice(idx, 1)[0];
        removed._added = false;
        if (removed.kind === "mathtex" && removed._el && removed._el.parentNode) {
          removed._el.parentNode.removeChild(removed._el);
          removed._el = undefined;
        }
      }
    },

    beat(
      indexOrTitle: number | string,
      titleOrSubtitle: string,
      subtitleOrFn: string | ((tl: gsap.core.Timeline) => void),
      maybeBuildFn?: (tl: gsap.core.Timeline) => void
    ): gsap.core.Timeline {
      let index: number;
      let title: string;
      let subtitle: string;
      let buildFn: (tl: gsap.core.Timeline) => void;

      if (typeof indexOrTitle === "number") {
        index = indexOrTitle;
        title = titleOrSubtitle;
        if (typeof subtitleOrFn === "function") {
          subtitle = "";
          buildFn = subtitleOrFn;
        } else {
          subtitle = subtitleOrFn ?? "";
          buildFn = maybeBuildFn ?? (() => {});
        }
      } else {
        index = beats.length;
        title = indexOrTitle;
        subtitle = titleOrSubtitle;
        buildFn = typeof subtitleOrFn === "function" ? subtitleOrFn : () => {};
      }

      const subTl = gsap.timeline();
      buildFn(subTl);
      if (subTl.duration() < 0.15) {
        subTl.to({}, { duration: 0.3 });
      }

      const startTime = beats.length === 0 ? 0 : masterTl.duration() + 0.35;
      masterTl.addLabel(`beat_${index}`, startTime);
      masterTl.add(subTl, startTime);

      beats.push({
        index,
        title,
        subtitle,
        startTime,
        duration: subTl.duration(),
      });

      return subTl;
    },

    create(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject | BaseMobject[],
      dur = 0.8,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      const list = Array.isArray(obj) ? obj.filter(Boolean) : obj ? [obj] : [];
      if (list.length === 0) return targetTl;
      const safeDur = Math.max(0.05, dur);
      const sub = gsap.timeline();
      list.forEach((item, idx) => {
        ensureAdded(item);
        const offset = idx * Math.min(0.12, safeDur * 0.2);
        sub.to(
          item,
          {
            opacity: 1,
            duration: Math.min(0.24, safeDur * 0.35),
            ease: "power2.out",
          },
          offset
        );
        sub.to(
          item,
          {
            drawProgress: 1,
            duration: safeDur,
            ease: "power2.inOut",
          },
          offset
        );
      });
      targetTl.add(sub, at);
      return targetTl;
    },

    write(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject | BaseMobject[],
      dur = 0.65,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      const list = Array.isArray(obj) ? obj.filter(Boolean) : obj ? [obj] : [];
      if (list.length === 0) return targetTl;
      const safeDur = Math.max(0.05, dur);
      const sub = gsap.timeline();
      list.forEach((item, idx) => {
        ensureAdded(item);
        if (item.opacity === 0) {
          item.offsetY = 10;
        }
        const offset = idx * Math.min(0.12, safeDur * 0.2);
        sub.to(
          item,
          {
            opacity: 1,
            duration: Math.min(0.24, safeDur * 0.4),
            ease: "power2.out",
          },
          offset
        );
        sub.to(
          item,
          {
            drawProgress: 1,
            duration: safeDur,
            ease: "power2.inOut",
          },
          offset
        );
        sub.to(
          item,
          {
            offsetY: 0,
            duration: safeDur,
            ease: "power3.out",
          },
          offset
        );
      });
      targetTl.add(sub, at);
      return targetTl;
    },

    fadeIn(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject | BaseMobject[],
      dur = 0.5,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      const list = Array.isArray(obj) ? obj.filter(Boolean) : obj ? [obj] : [];
      if (list.length === 0) return targetTl;
      const safeDur = Math.max(0.05, dur);
      const sub = gsap.timeline();
      list.forEach((item, idx) => {
        ensureAdded(item);
        const offset = idx * Math.min(0.1, safeDur * 0.2);
        sub.set(item, { drawProgress: 1 }, offset);
        sub.to(item, { opacity: 1, duration: safeDur, ease: "power2.out" }, offset);
      });
      targetTl.add(sub, at);
      return targetTl;
    },

    fadeOut(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject | BaseMobject[],
      dur = 0.45,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      const list = Array.isArray(obj) ? obj.filter(Boolean) : obj ? [obj] : [];
      if (list.length === 0) return targetTl;
      list.forEach((item) => ensureAdded(item));
      targetTl.to(list, { opacity: 0, duration: Math.max(0.05, dur), ease: "power2.inOut" }, at);
      return targetTl;
    },

    to(
      tl: gsap.core.Timeline | null | undefined,
      obj: object,
      props: gsap.TweenVars,
      dur = 0.8,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      if (obj && typeof obj === "object" && "kind" in obj) {
        ensureAdded(obj as BaseMobject);
      }
      targetTl.to(
        obj,
        {
          duration: Math.max(0.01, dur),
          ease: "power2.inOut",
          ...props,
        },
        at
      );
      return targetTl;
    },

    moveTo(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject,
      x: number,
      y: number,
      dur = 0.8,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      ensureAdded(obj);
      targetTl.to(obj, { x, y, duration: Math.max(0.05, dur), ease: "power2.inOut" }, at);
      return targetTl;
    },

    shift(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject,
      dx: number,
      dy: number,
      dur = 0.8,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      ensureAdded(obj);
      targetTl.to(
        obj,
        {
          x: `+=${dx}`,
          y: `+=${dy}`,
          duration: Math.max(0.05, dur),
          ease: "power2.inOut",
        },
        at
      );
      return targetTl;
    },

    scale(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject,
      s: number,
      dur = 0.6,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      ensureAdded(obj);
      targetTl.to(obj, { scale: s, duration: Math.max(0.05, dur), ease: "power2.out" }, at);
      return targetTl;
    },

    rotate(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject,
      rad: number,
      dur = 0.8,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      ensureAdded(obj);
      targetTl.to(obj, { rotation: rad, duration: Math.max(0.05, dur), ease: "power2.inOut" }, at);
      return targetTl;
    },

    indicate(
      tl: gsap.core.Timeline | null | undefined,
      obj: BaseMobject | BaseMobject[],
      dur = 0.7,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      const list = Array.isArray(obj) ? obj.filter(Boolean) : obj ? [obj] : [];
      if (list.length === 0) return targetTl;
      const safeDur = Math.max(0.15, dur);
      const up = safeDur * 0.44;
      const down = safeDur - up;
      const sub = gsap.timeline();
      list.forEach((item, idx) => {
        ensureAdded(item);
        const baseScale = item.scale || 1;
        const offset = idx * 0.08;
        sub.to(
          item,
          {
            scale: baseScale * 1.16,
            glowIntensity: 2.7,
            duration: up,
            ease: "power2.out",
          },
          offset
        );
        sub.to(
          item,
          {
            scale: baseScale,
            glowIntensity: 1,
            duration: down,
            ease: "power2.inOut",
          },
          offset + up
        );
      });
      targetTl.add(sub, at);
      return targetTl;
    },

    pulsePacket(
      tl: gsap.core.Timeline | null | undefined,
      edgeOrCoords: EdgeMobject | [EndpointRef, EndpointRef] | { from: EndpointRef; to: EndpointRef },
      color?: string,
      dur = 0.8,
      at?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      const safeDur = Math.max(0.12, dur);
      const resolvedColor =
        color ??
        (!Array.isArray(edgeOrCoords) && "color" in edgeOrCoords && edgeOrCoords.color
          ? edgeOrCoords.color
          : COLORS.cyan);

      const pkt: PacketState = {
        target: edgeOrCoords,
        t: 0,
        opacity: 0,
        color: resolvedColor,
        size: 5.5,
      };
      packets.push(pkt);

      const fadeInDur = Math.min(0.12, safeDur * 0.2);
      const fadeOutDur = Math.min(0.16, safeDur * 0.22);
      const sub = gsap.timeline();
      sub.to(pkt, { opacity: 1, duration: fadeInDur, ease: "power1.out" }, 0);
      sub.to(pkt, { t: 1, duration: safeDur, ease: "power1.inOut" }, 0);
      sub.to(pkt, { opacity: 0, duration: fadeOutDur, ease: "power1.in" }, Math.max(0, safeDur - fadeOutDur));
      targetTl.add(sub, at);
      return targetTl;
    },

    moveAlongCurve(
      tl: gsap.core.Timeline | null | undefined,
      dot: DotMobject,
      axes: AxesMobject,
      fn: (x: number) => number,
      x0: number,
      x1: number,
      dur = 1.4,
      curveOpts: MoveAlongCurveOpts = {},
      atArg?: gsap.Position
    ): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      ensureAdded(dot);
      ensureAdded(axes);

      // Support BOTH `{ tangentArrow: true }` (auto-managed glowing downhill vector)
      // AND `{ tangentArrow: myArrowMobject }`!
      let resolvedTangentArrow: ArrowMobject | undefined;
      let autoCreatedTangent = false;
      if (curveOpts.tangentArrow === true) {
        if (!dot._autoTangentArrow) {
          dot._autoTangentArrow = M.Arrow({
            axes,
            color: COLORS.amber,
            width: 2.5,
            headSize: 10,
            visible: false,
            zIndex: (dot.zIndex || 0) + 1,
          });
          autoCreatedTangent = true;
        }
        resolvedTangentArrow = dot._autoTangentArrow;
        ensureAdded(resolvedTangentArrow);
      } else if (
        curveOpts.tangentArrow &&
        typeof curveOpts.tangentArrow === "object"
      ) {
        resolvedTangentArrow = curveOpts.tangentArrow;
        ensureAdded(resolvedTangentArrow);
      }

      const seg: CurveSegment = {
        axes,
        fn,
        x0,
        x1,
        p: 0,
        color: curveOpts.traceColor ?? dot.traceColor ?? dot.color,
        tangentArrow: resolvedTangentArrow,
        tangentLength: curveOpts.tangentLength,
        tangentScale: curveOpts.tangentScale,
        downhill: curveOpts.downhill,
        constantLength: curveOpts.constantLength,
      };
      dot._curveSegments.push(seg);

      // Initialize tangent arrow cleanly at initial position before playback begins
      if (resolvedTangentArrow && !resolvedTangentArrow._tangentInit) {
        resolvedTangentArrow._tangentInit = true;
        updateTangentArrowForCurve(resolvedTangentArrow, axes, fn, x0, fn(x0), curveOpts);
      }

      const position = curveOpts.at ?? atArg;
      const safeDur = Math.max(0.05, dur);
      if (autoCreatedTangent && resolvedTangentArrow) {
        const sub = gsap.timeline();
        sub.set(resolvedTangentArrow, { drawProgress: 1 }, 0);
        sub.to(resolvedTangentArrow, { opacity: 1, duration: Math.min(0.25, safeDur * 0.25), ease: "power2.out" }, 0);
        sub.to(
          seg,
          {
            p: 1,
            duration: safeDur,
            ease: curveOpts.ease ?? "power2.inOut",
          },
          0
        );
        targetTl.add(sub, position);
      } else {
        targetTl.to(
          seg,
          {
            p: 1,
            duration: safeDur,
            ease: curveOpts.ease ?? "power2.inOut",
          },
          position
        );
      }

      return targetTl;
    },

    tracePath(dot: DotMobject, color?: string): DotMobject {
      ensureAdded(dot);
      dot.traceEnabled = true;
      if (color) {
        dot.traceColor = color;
      }
      return dot;
    },

    wait(tl: gsap.core.Timeline | null | undefined, dur = 0.5): gsap.core.Timeline {
      const targetTl = resolveTl(tl);
      targetTl.to({}, { duration: Math.max(0.01, dur) });
      return targetTl;
    },
  };

  /* ==========================================================================
   * FRAME SYNC & RENDER PIPELINE (60fps HiDPI)
   * ========================================================================== */

  const syncDeterministicCurveDots = () => {
    for (const m of mobjects) {
      if (m.kind !== "dot") continue;
      if (m._curveSegments.length > 0) {
        // Pick the latest segment that has started (p > 0), otherwise segment 0 at p = 0
        let activeSeg = m._curveSegments[0];
        for (let i = 0; i < m._curveSegments.length; i++) {
          if (m._curveSegments[i].p > 0) {
            activeSeg = m._curveSegments[i];
          }
        }
        const mx = lerp(activeSeg.x0, activeSeg.x1, activeSeg.p);
        const my = activeSeg.fn(mx);
        if (Number.isFinite(my)) {
          if (m.axes) {
            m.x = mx;
            m.y = my;
          } else {
            const [nx, ny] = activeSeg.axes.toNorm(mx, my);
            m.x = nx;
            m.y = ny;
          }
          if (activeSeg.tangentArrow) {
            updateTangentArrowForCurve(activeSeg.tangentArrow, activeSeg.axes, activeSeg.fn, mx, my, {
              tangentLength: activeSeg.tangentLength,
              tangentScale: activeSeg.tangentScale,
              downhill: activeSeg.downhill,
              constantLength: activeSeg.constantLength,
            });
          }
        }
      } else if (m.traceEnabled && m.opacity > 0.05 && m.drawProgress > 0.05) {
        // Live trail recording for moveTo / shift motions
        const [nx, ny] = m.axes ? m.axes.toNorm(m.x, m.y) : [m.x, m.y];
        const prev = m._lastTrailPt;
        if (!prev || Math.hypot(nx - prev.x, ny - prev.y) > 0.004) {
          m.trail.push({ x: nx, y: ny });
          if (m.trail.length > 480) m.trail.shift();
          m._lastTrailPt = { x: nx, y: ny };
        }
      }
    }
  };

  const renderFrame = () => {
    if (disposed || !ctx) return;

    syncDeterministicCurveDots();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStageBackground(ctx, W, H);

    const fontScale = clamp(Math.min(W / 640, H / 440), 0.72, 1.35);

    // Stable sort by zIndex (preserving insertion order for ties)
    const ordered = mobjects
      .map((m, idx) => ({ m, idx }))
      .sort((a, b) => (a.m.zIndex - b.m.zIndex) || (a.idx - b.idx));

    for (const { m } of ordered) {
      switch (m.kind) {
        case "axes":
          renderAxes(ctx, m, W, H, fontScale);
          break;
        case "plot":
          renderPlot(ctx, m, W, H, fontScale);
          break;
        case "edge":
          renderEdge(ctx, m, W, H, fontScale);
          break;
        case "line":
          renderLine(ctx, m, W, H, fontScale);
          break;
        case "arrow":
          renderArrow(ctx, m, W, H, fontScale);
          break;
        case "spring":
          renderSpring(ctx, m, W, H, fontScale);
          break;
        case "circle":
          renderCircle(ctx, m, W, H, fontScale);
          break;
        case "rect":
          renderRect(ctx, m, W, H, fontScale);
          break;
        case "polygon":
          renderPolygon(ctx, m, W, H, fontScale);
          break;
        case "arc":
          renderArc(ctx, m, W, H, fontScale);
          break;
        case "barchart":
          renderBarChart(ctx, m, W, H, fontScale);
          break;
        case "node":
          renderNode(ctx, m, W, H, fontScale);
          break;
        case "dot":
          renderDot(ctx, m, W, H, fontScale);
          break;
        case "text":
          renderText(ctx, m, W, H, fontScale);
          break;
        case "mathtex":
          syncMathTexElement(m, overlayLayer, W, fontScale);
          break;
      }
    }

    // Render luminous flying photon packets on top of edges/nodes
    for (let i = 0; i < packets.length; i++) {
      renderPacket(ctx, packets[i], W, H);
    }
  };

  /* ==========================================================================
   * EXECUTE USER / LLM SCRIPT SAFELY
   * ========================================================================== */

  const cleanedCode = stripCodeFences(code);
  let scriptFailed = false;

  try {
    const runner = new Function("scene", "M", "gsap", "COLORS", cleanedCode);
    runner(scene, M, gsap, COLORS);
  } catch (err) {
    scriptFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    onError?.(`Manim animation error: ${message}`);
  }

  if (!scriptFailed) {
    masterTl.seek(0, false);
    masterTl.play();
  }

  // Initial synchronous frame + state push
  renderFrame();
  emitState(true);

  const tick = () => {
    if (disposed) return;
    rafId = requestAnimationFrame(tick);
    renderFrame();
    emitState(false);
  };
  rafId = requestAnimationFrame(tick);

  /* ==========================================================================
   * PUBLIC CONTROLLER
   * ========================================================================== */

  const controller: ManimController = {
    play() {
      if (disposed || scriptFailed) return;
      if (masterTl.progress() >= 0.999) {
        clearTransientTrails();
        masterTl.restart();
      } else {
        masterTl.play();
      }
      renderFrame();
      emitState(true);
    },

    pause() {
      if (disposed) return;
      masterTl.pause();
      renderFrame();
      emitState(true);
    },

    restart() {
      if (disposed || scriptFailed) return;
      clearTransientTrails();
      masterTl.restart();
      renderFrame();
      emitState(true);
    },

    seek(seconds: number) {
      if (disposed || scriptFailed) return;
      const clamped = clamp(seconds, 0, getTimelineDuration());
      clearTransientTrails();
      masterTl.seek(clamped, false);
      renderFrame();
      emitState(true);
    },

    setSpeed(rate: number) {
      if (disposed) return;
      const safeRate = clamp(Number.isFinite(rate) ? rate : 1, 0.1, 8);
      masterTl.timeScale(safeRate);
    },

    jumpToBeat(beatIndex: number) {
      if (disposed || scriptFailed) return;
      const target =
        beats.find((b) => b.index === beatIndex) ??
        (beatIndex >= 0 && beatIndex < beats.length ? beats[beatIndex] : undefined);
      if (!target) return;
      clearTransientTrails();
      masterTl.seek(target.startTime, false);
      masterTl.play();
      renderFrame();
      emitState(true);
    },

    getDuration() {
      return getTimelineDuration();
    },

    getTime() {
      return masterTl.time();
    },

    getBeats() {
      return beats.map((b) => ({ ...b }));
    },

    resize() {
      resize();
      renderFrame();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(rafId);
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      masterTl.kill();
      overlayLayer.innerHTML = "";
      mobjects.length = 0;
      packets.length = 0;
      beats.length = 0;
    },
  };

  return controller;
}
