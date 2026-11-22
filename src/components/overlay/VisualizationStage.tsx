import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import mermaid from "mermaid";
import "katex/dist/katex.min.css";
import {
  AlertTriangle,
  BarChart3,
  Box,
  Check,
  Code2,
  Copy,
  GitBranch,
  Grid3x3,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Shapes,
  Sparkles,
  Terminal,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  OverlayVizCueEvent,
  OverlayVizEvent,
  OverlayVizLoadingEvent,
  VizKind,
} from "../../types/events";
import {
  mountManimScene,
  type ManimBeatInfo,
  type ManimController,
} from "./manimEngine";

export interface VisualizationStageProps {
  viz: OverlayVizEvent | null;
  loading?: OverlayVizLoadingEvent | null;
  activeCue?: OverlayVizCueEvent | null;
  onClose: () => void;
  onRectChange?: (rect: DOMRect | null) => void;
}

const CHART_PALETTE = [
  "#10b981",
  "#38bdf8",
  "#f59e0b",
  "#a855f7",
  "#f43f5e",
  "#2dd4bf",
];

let mermaidInitialized = false;
let mermaidRenderSeq = 0;

function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaidInitialized = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "strict",
    fontFamily: "Inter, system-ui, -apple-system, sans-serif",
    themeVariables: {
      primaryColor: "#064e3b",
      primaryBorderColor: "#10b981",
      primaryTextColor: "#f4f4f5",
      lineColor: "#34d399",
      secondaryColor: "#083344",
      tertiaryColor: "#18181b",
      background: "#09090b",
      mainBkg: "#064e3b",
      nodeBorder: "#10b981",
      clusterBkg: "#111318",
      clusterBorder: "#27272a",
      edgeLabelBackground: "#18181b",
    },
  });
}

function stripCodeFences(raw: string): string {
  const trimmed = (raw || "").trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  return match ? match[1].trim() : trimmed;
}

function getEngineMeta(kind: VizKind | string): {
  label: string;
  badgeClass: string;
  icon: React.ReactNode;
} {
  switch (kind) {
    case "three":
      return {
        label: "THREE.JS 3D",
        badgeClass:
          "bg-cyan-500/15 text-cyan-300 border border-cyan-400/35",
        icon: <Box className="w-3 h-3" />,
      };
    case "mermaid":
      return {
        label: "MERMAID",
        badgeClass:
          "bg-violet-500/15 text-violet-300 border border-violet-400/35",
        icon: <GitBranch className="w-3 h-3" />,
      };
    case "svg":
      return {
        label: "SVG",
        badgeClass:
          "bg-amber-500/15 text-amber-300 border border-amber-400/35",
        icon: <Shapes className="w-3 h-3" />,
      };
    case "chart":
      return {
        label: "CHART",
        badgeClass:
          "bg-teal-500/15 text-teal-300 border border-teal-400/35",
        icon: <BarChart3 className="w-3 h-3" />,
      };
    case "anim":
      return {
        label: "MANIM ANIM",
        badgeClass:
          "bg-gradient-to-r from-emerald-500/20 via-teal-500/20 to-indigo-500/25 text-emerald-200 border border-emerald-400/45 shadow-[0_0_12px_rgba(16,185,129,0.28)]",
        icon: <Sparkles className="w-3 h-3 text-emerald-300" />,
      };
    case "html":
    case "canvas":
    default:
      return {
        label: "HTML/CANVAS",
        badgeClass:
          "bg-emerald-500/15 text-emerald-300 border border-emerald-400/35",
        icon: <Terminal className="w-3 h-3" />,
      };
  }
}

/* ============================================================================
 * 1. HTML / CANVAS SANDBOXED IFRAME ENGINE
 * ============================================================================ */

const STICKY_VIZ_HELPER_SCRIPT = `
(function(){
  if (window.StickyViz) return;
  const palette = {
    bg: "#09090b",
    surface: "#111318",
    surface2: "#18181b",
    border: "rgba(255,255,255,0.1)",
    emerald: "#10b981",
    emeraldLight: "#34d399",
    cyan: "#38bdf8",
    amber: "#f59e0b",
    purple: "#a855f7",
    rose: "#f43f5e",
    text: "#f4f4f5",
    muted: "#a1a1aa",
    grid: "rgba(255,255,255,0.07)"
  };
  const easings = {
    linear: function(t){ return t; },
    easeInQuad: function(t){ return t * t; },
    easeOutQuad: function(t){ return t * (2 - t); },
    easeInOutQuad: function(t){ return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; },
    easeInOutCubic: function(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; },
    easeOutCubic: function(t){ return 1 - Math.pow(1 - t, 3); },
    easeOutExpo: function(t){ return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    easeOutBack: function(t){ const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  };
  function springStep(state, target, opts){
    const o = opts || {};
    const k = o.stiffness != null ? o.stiffness : 180;
    const c = o.damping != null ? o.damping : 14;
    const m = o.mass != null ? o.mass : 1;
    const dt = Math.min(o.dt != null ? o.dt : 1/60, 0.05);
    const force = -k * (state.x - target) - c * state.v;
    const a = force / m;
    const v = state.v + a * dt;
    const x = state.x + v * dt;
    return { x: x, v: v };
  }
  function createCanvas(parent){
    const host = parent || document.body;
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const api = { canvas: canvas, ctx: ctx, width: 300, height: 200, dpr: 1, resize: function(){} };
    api.resize = function(){
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      api.width = Math.max(1, rect.width || window.innerWidth);
      api.height = Math.max(1, rect.height || window.innerHeight);
      api.dpr = dpr;
      canvas.width = Math.round(api.width * dpr);
      canvas.height = Math.round(api.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    api.resize();
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(function(){ api.resize(); }).observe(host);
    } else {
      window.addEventListener("resize", api.resize);
    }
    return api;
  }
  window.StickyViz = { palette: palette, easings: easings, springStep: springStep, createCanvas: createCanvas };
})();
`;

function buildHtmlSrcDoc(rawCode: string, kind: VizKind): string {
  const code = stripCodeFences(rawCode);
  const helperTag = `<script>${STICKY_VIZ_HELPER_SCRIPT}<\/script>`;

  // Case 1: Full HTML document — inject StickyViz helper into <head>
  if (/^\s*(<!doctype\s+html|<html\b)/i.test(code)) {
    if (/<head\b[^>]*>/i.test(code)) {
      return code.replace(/<head\b[^>]*>/i, (m) => `${m}\n${helperTag}`);
    }
    if (/<\/head>/i.test(code)) {
      return code.replace(/<\/head>/i, `${helperTag}\n</head>`);
    }
    if (/<body\b[^>]*>/i.test(code)) {
      return code.replace(/<body\b[^>]*>/i, (m) => `<head>${helperTag}</head>\n${m}`);
    }
    return `${helperTag}\n${code}`;
  }

  // Case 2: Raw JS canvas body (no HTML tags)
  const looksLikeHtml = /<(canvas|div|svg|section|main|header|script|style|p|h[1-6]|button|input)\b/i.test(
    code
  );
  if (kind === "canvas" && !looksLikeHtml) {
    const escapedJs = JSON.stringify(code);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#09090b;color:#f4f4f5;font-family:Inter,system-ui,-apple-system,sans-serif;}
  #root{position:relative;width:100%;height:100%;}
  #err{display:none;position:absolute;inset:12px;padding:12px;border-radius:10px;background:rgba(127,29,29,0.85);border:1px solid rgba(248,113,113,0.5);color:#fecaca;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow:auto;}
</style>
${helperTag}
</head>
<body>
<div id="root"></div>
<div id="err"></div>
<script>
(function(){
  try {
    var root = document.getElementById("root");
    var stage = window.StickyViz.createCanvas(root);
    var fn = new Function("canvas", "ctx", "width", "height", "StickyViz", ${escapedJs});
    fn(stage.canvas, stage.ctx, stage.width, stage.height, window.StickyViz);
  } catch (e) {
    var el = document.getElementById("err");
    el.style.display = "block";
    el.textContent = "Canvas execution error:\\n" + (e && e.message ? e.message : String(e));
  }
})();
<\/script>
</body>
</html>`;
  }

  // Case 3: HTML snippet — wrap inside dark-glass document
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:auto;background:#09090b;color:#f4f4f5;font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;}
  ::-webkit-scrollbar{width:6px;height:6px}
  ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.16);border-radius:999px}
</style>
${helperTag}
</head>
<body>
${code}
</body>
</html>`;
}

const HtmlCanvasEngine: React.FC<{
  code: string;
  kind: VizKind;
  title: string;
  reloadKey: number;
}> = ({ code, kind, title, reloadKey }) => {
  const srcDoc = useMemo(() => buildHtmlSrcDoc(code, kind), [code, kind]);

  return (
    <iframe
      key={`${reloadKey}-${kind}`}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={title}
      className="w-full h-full border-0 block bg-zinc-950"
    />
  );
};

/* ============================================================================
 * 2. THREE.JS LIVE WEBGL 3D ENGINE
 * ============================================================================ */

function disposeThreeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && typeof mesh.geometry.dispose === "function") {
      mesh.geometry.dispose();
    }
    const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) {
      mat.forEach((m) => disposeMaterial(m));
    } else if (mat) {
      disposeMaterial(mat);
    }
  });
}

function disposeMaterial(mat: THREE.Material) {
  const record = mat as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (val && typeof val === "object" && "isTexture" in val && typeof (val as THREE.Texture).dispose === "function") {
      (val as THREE.Texture).dispose();
    }
  }
  mat.dispose();
}

const ThreeEngine: React.FC<{ code: string; reloadKey: number }> = ({
  code,
  reloadKey,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [wireframe, setWireframe] = useState(false);

  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;

  const groupRef = useRef<THREE.Group | null>(null);
  const origWireframeMapRef = useRef<WeakMap<THREE.Material, boolean>>(new WeakMap());
  const resetCameraRef = useRef<(() => void) | null>(null);

  // Sync wireframe toggle onto scene group meshes cleanly
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const origMap = origWireframeMapRef.current;
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        if (!m || !("wireframe" in m)) return;
        const stdMat = m as THREE.MeshStandardMaterial;
        if (!origMap.has(m)) {
          origMap.set(m, Boolean(stdMat.wireframe));
        }
        stdMat.wireframe = wireframe ? true : Boolean(origMap.get(m));
      });
    });
  }, [wireframe, reloadKey, code]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setErrorMsg(null);
    origWireframeMapRef.current = new WeakMap();

    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 220);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch (e) {
      setErrorMsg(
        `WebGL initialization failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
    camera.position.set(0, 2.0, 5.8);
    camera.lookAt(0, 0, 0);

    // Studio lighting: ambient + hemisphere + key directional + emerald rim + cyan fill
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x38bdf8, 0x09090b, 0.45);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(6, 10, 7);
    scene.add(keyLight);

    const emeraldRim = new THREE.PointLight(0x10b981, 2.6, 26);
    emeraldRim.position.set(-5, 3.2, -4);
    scene.add(emeraldRim);

    const cyanFill = new THREE.PointLight(0x38bdf8, 1.4, 22);
    cyanFill.position.set(5, -1.5, 4.5);
    scene.add(cyanFill);

    // Subtle emerald perspective floor grid
    const grid = new THREE.GridHelper(14, 28, 0x10b981, 0x27272a);
    grid.position.y = -1.6;
    const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMats.forEach((m) => {
      m.transparent = true;
      m.opacity = 0.22;
    });
    scene.add(grid);

    const group = new THREE.Group();
    scene.add(group);
    groupRef.current = group;

    const frameCallbacks: Array<(t: number, dt: number) => void> = [];
    const onFrame = (cb: (t: number, dt: number) => void) => {
      if (typeof cb === "function") {
        frameCallbacks.push(cb);
      }
    };

    // Execute LLM / preset Three.js body safely
    const cleaned = stripCodeFences(code);
    try {
      const runner = new Function(
        "THREE",
        "scene",
        "camera",
        "group",
        "onFrame",
        cleaned
      );
      runner(THREE, scene, camera, group, onFrame);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErrorMsg(`Scene script error: ${message}`);
      // Fallback glowing emerald geometry so stage remains alive
      const fallbackGeo = new THREE.IcosahedronGeometry(1.15, 1);
      const fallbackMesh = new THREE.Mesh(
        fallbackGeo,
        new THREE.MeshStandardMaterial({
          color: 0x064e3b,
          emissive: 0x10b981,
          emissiveIntensity: 0.35,
          roughness: 0.25,
          metalness: 0.75,
        })
      );
      const fallbackWire = new THREE.LineSegments(
        new THREE.EdgesGeometry(fallbackGeo),
        new THREE.LineBasicMaterial({ color: 0x34d399 })
      );
      group.add(fallbackMesh, fallbackWire);
      onFrame((t) => {
        fallbackMesh.rotation.y = t * 0.6;
        fallbackWire.rotation.y = t * 0.6;
        fallbackMesh.rotation.x = Math.sin(t * 0.5) * 0.25;
        fallbackWire.rotation.x = Math.sin(t * 0.5) * 0.25;
      });
    }

    // Apply current wireframe toggle if already enabled
    if (wireframe) {
      const origMap = origWireframeMapRef.current;
      group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          if (!m || !("wireframe" in m)) return;
          const stdMat = m as THREE.MeshStandardMaterial;
          if (!origMap.has(m)) origMap.set(m, Boolean(stdMat.wireframe));
          stdMat.wireframe = true;
        });
      });
    }

    // Derive initial spherical coordinates from camera.position
    const initPos = camera.position.clone();
    const initRadius = Math.max(2.2, initPos.length() || 6.0);
    const initPhi = Math.max(
      0.18,
      Math.min(Math.PI - 0.18, Math.acos(Math.max(-1, Math.min(1, initPos.y / initRadius))))
    );
    const initTheta = Math.atan2(initPos.x, initPos.z);

    const orbit = {
      radius: initRadius,
      theta: initTheta,
      phi: initPhi,
      targetRadius: initRadius,
      targetTheta: initTheta,
      targetPhi: initPhi,
      dragging: false,
      lastX: 0,
      lastY: 0,
    };

    resetCameraRef.current = () => {
      orbit.targetRadius = initRadius;
      orbit.targetTheta = initTheta;
      orbit.targetPhi = initPhi;
    };

    const domEl = renderer.domElement;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      orbit.dragging = true;
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!orbit.dragging) return;
      const dx = e.clientX - orbit.lastX;
      const dy = e.clientY - orbit.lastY;
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;
      orbit.targetTheta -= dx * 0.0085;
      orbit.targetPhi = Math.max(
        0.18,
        Math.min(Math.PI - 0.18, orbit.targetPhi - dy * 0.0085)
      );
    };

    const handleMouseUp = () => {
      orbit.dragging = false;
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = 1 + Math.sign(e.deltaY) * 0.1;
      orbit.targetRadius = Math.max(2.0, Math.min(20.0, orbit.targetRadius * factor));
    };

    domEl.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    domEl.addEventListener("wheel", handleWheel, { passive: false });

    const resizeObserver = new ResizeObserver(() => {
      const w = Math.max(container.clientWidth, 100);
      const h = Math.max(container.clientHeight, 100);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    let rafId = 0;
    let lastTime = performance.now();
    const startTime = lastTime;
    let frameFailed = false;

    const animate = (now: number) => {
      rafId = requestAnimationFrame(animate);
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const elapsed = (now - startTime) / 1000;

      if (autoRotateRef.current && !orbit.dragging) {
        orbit.targetTheta += dt * 0.34;
      }

      // Smooth exponential camera damping
      const damp = 1 - Math.exp(-10 * dt);
      orbit.theta += (orbit.targetTheta - orbit.theta) * damp;
      orbit.phi += (orbit.targetPhi - orbit.phi) * damp;
      orbit.radius += (orbit.targetRadius - orbit.radius) * damp;

      const sinPhi = Math.sin(orbit.phi);
      camera.position.set(
        orbit.radius * sinPhi * Math.sin(orbit.theta),
        orbit.radius * Math.cos(orbit.phi),
        orbit.radius * sinPhi * Math.cos(orbit.theta)
      );
      camera.lookAt(0, 0.1, 0);

      if (!frameFailed) {
        for (let i = 0; i < frameCallbacks.length; i++) {
          try {
            frameCallbacks[i](elapsed, dt);
          } catch (err) {
            frameFailed = true;
            setErrorMsg(
              `Animation loop error: ${err instanceof Error ? err.message : String(err)}`
            );
            break;
          }
        }
      }

      renderer.render(scene, camera);
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      domEl.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      domEl.removeEventListener("wheel", handleWheel);
      groupRef.current = null;
      resetCameraRef.current = null;
      disposeThreeObject(scene);
      renderer.dispose();
      if (domEl.parentNode === container) {
        container.removeChild(domEl);
      }
    };
  }, [code, reloadKey]);

  return (
    <div className="relative w-full h-full bg-[radial-gradient(ellipse_at_center,rgba(16,185,129,0.09)_0%,rgba(9,9,11,0.98)_72%)] overflow-hidden">
      <div
        ref={containerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
      />

      {/* Inline error notification (non-crashing) */}
      {errorMsg && (
        <div className="absolute top-3 left-3 right-3 z-20 flex items-start gap-2 px-3 py-2 rounded-xl bg-rose-950/90 border border-rose-500/40 text-[11px] text-rose-200 backdrop-blur-md">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
          <span className="font-mono break-all leading-snug">{errorMsg}</span>
        </div>
      )}

      {/* Floating 3D Viewport Controls */}
      <div className="absolute bottom-3 left-3 right-3 z-10 flex items-center justify-between pointer-events-none">
        <span className="px-2.5 py-1 rounded-full bg-zinc-950/80 border border-white/10 text-[10px] font-medium text-zinc-400 backdrop-blur-md">
          Drag to orbit · Scroll to zoom
        </span>

        <div className="flex items-center gap-1.5 pointer-events-auto">
          <button
            onClick={() => setAutoRotate((v) => !v)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium backdrop-blur-md border transition-colors ${
              autoRotate
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-400/40"
                : "bg-zinc-900/85 text-zinc-400 border-white/10 hover:text-zinc-200"
            }`}
            title="Toggle Auto-Rotate"
          >
            {autoRotate ? (
              <Pause className="w-3 h-3" />
            ) : (
              <Play className="w-3 h-3" />
            )}
            <span>Auto-Rotate</span>
          </button>

          <button
            onClick={() => setWireframe((v) => !v)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium backdrop-blur-md border transition-colors ${
              wireframe
                ? "bg-cyan-500/20 text-cyan-300 border-cyan-400/40"
                : "bg-zinc-900/85 text-zinc-400 border-white/10 hover:text-zinc-200"
            }`}
            title="Toggle Wireframe Overlay"
          >
            <Grid3x3 className="w-3 h-3" />
            <span>Wireframe</span>
          </button>

          <button
            onClick={() => resetCameraRef.current?.()}
            className="p-1.5 rounded-full bg-zinc-900/85 text-zinc-400 hover:text-white border border-white/10 backdrop-blur-md transition-colors"
            title="Reset Camera View"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * 3. MERMAID NATIVE SVG DIAGRAM ENGINE
 * ============================================================================ */

const MermaidEngine: React.FC<{ code: string; reloadKey: number }> = ({
  code,
  reloadKey,
}) => {
  const [svgMarkup, setSvgMarkup] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ active: boolean; x: number; y: number; px: number; py: number }>({
    active: false,
    x: 0,
    y: 0,
    px: 0,
    py: 0,
  });

  useEffect(() => {
    let cancelled = false;
    setErrorMsg(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });

    const renderDiagram = async () => {
      ensureMermaidInit();
      const cleaned = stripCodeFences(code);
      const id = `sticky_mmd_${++mermaidRenderSeq}_${Date.now()}`;
      try {
        const result = await mermaid.render(id, cleaned);
        if (!cancelled) {
          setSvgMarkup(result.svg);
        }
      } catch (e) {
        // Remove any temporary error SVG Mermaid attaches to document.body
        const stray = document.getElementById(`d${id}`);
        if (stray) stray.remove();
        if (!cancelled) {
          setSvgMarkup("");
          setErrorMsg(e instanceof Error ? e.message : String(e));
        }
      }
    };

    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [code, reloadKey]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = {
      active: true,
      x: e.clientX,
      y: e.clientY,
      px: pan.x,
      py: pan.y,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return;
      setPan({
        x: dragRef.current.px + (e.clientX - dragRef.current.x),
        y: dragRef.current.py + (e.clientY - dragRef.current.y),
      });
    };
    const onUp = () => {
      dragRef.current.active = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
    const delta = e.deltaY < 0 ? 0.12 : -0.12;
    setZoom((z) => Math.max(0.45, Math.min(2.6, +(z + delta).toFixed(2))));
  };

  return (
    <div
      className="relative w-full h-full bg-zinc-950 overflow-hidden select-none"
      onWheel={handleWheel}
    >
      {errorMsg ? (
        <div className="p-4 h-full overflow-auto flex flex-col gap-3">
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-rose-950/75 border border-rose-500/40 text-xs text-rose-200">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-rose-100 mb-0.5">
                Mermaid Diagram Syntax Error
              </div>
              <div className="font-mono text-[11px] opacity-90">{errorMsg}</div>
            </div>
          </div>
          <pre className="p-3 rounded-xl bg-zinc-900/90 border border-white/10 text-[11px] font-mono text-zinc-300 overflow-auto">
            {stripCodeFences(code)}
          </pre>
        </div>
      ) : (
        <div
          onMouseDown={handleMouseDown}
          className="w-full h-full flex items-center justify-center p-5 cursor-grab active:cursor-grabbing"
        >
          <div
            className="transition-transform duration-75 ease-out [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:drop-shadow-[0_6px_24px_rgba(16,185,129,0.14)]"
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: "center center",
            }}
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
          />
        </div>
      )}

      {/* Zoom Controls */}
      {!errorMsg && (
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 px-1.5 py-1 rounded-full bg-zinc-900/90 border border-white/10 backdrop-blur-md text-[11px]">
          <button
            onClick={() => setZoom((z) => Math.max(0.45, +(z - 0.15).toFixed(2)))}
            className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Zoom Out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            className="px-1.5 text-zinc-300 hover:text-emerald-300 font-mono text-[10px]"
            title="Reset Zoom & Pan"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(2.6, +(z + 0.15).toFixed(2)))}
            className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Zoom In"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * 4. SVG SANITIZED VECTOR ENGINE
 * ============================================================================ */

function sanitizeSvg(rawCode: string): { svg: string; error: string | null } {
  const cleaned = stripCodeFences(rawCode);
  // First pass regex strip
  let safe = cleaned
    .replace(/<script\b[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/<(iframe|object|embed)\b[\s\S]*?>[\s\S]*?<\/\1>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*["']\s*javascript:[^"']*["']/gi, "");

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(safe, "image/svg+xml");
    const parseErr = doc.querySelector("parsererror");
    const root = doc.documentElement;
    if (!parseErr && root && root.tagName.toLowerCase() === "svg") {
      // Second pass DOM sanitization
      root
        .querySelectorAll("script, iframe, object, embed")
        .forEach((node) => node.remove());
      const allNodes = [root, ...Array.from(root.querySelectorAll("*"))];
      allNodes.forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
          const name = attr.name.toLowerCase();
          const val = attr.value.trim().toLowerCase();
          if (
            name.startsWith("on") ||
            ((name === "href" || name === "xlink:href") &&
              val.startsWith("javascript:"))
          ) {
            el.removeAttribute(attr.name);
          }
        });
      });
      if (!root.getAttribute("preserveAspectRatio")) {
        root.setAttribute("preserveAspectRatio", "xMidYMid meet");
      }
      safe = new XMLSerializer().serializeToString(root);
      return { svg: safe, error: null };
    }
    if (/<svg\b/i.test(safe)) {
      return { svg: safe, error: null };
    }
    return { svg: "", error: "Input does not contain a valid <svg> root element." };
  } catch (e) {
    return {
      svg: "",
      error: e instanceof Error ? e.message : "Failed to parse SVG markup.",
    };
  }
}

const SvgEngine: React.FC<{ code: string; reloadKey: number }> = ({
  code,
  reloadKey,
}) => {
  const [zoom, setZoom] = useState(1);
  const { svg, error } = useMemo(() => sanitizeSvg(code), [code]);

  useEffect(() => {
    setZoom(1);
  }, [code, reloadKey]);

  if (error) {
    return (
      <div className="p-4 h-full bg-zinc-950 flex items-center justify-center">
        <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-rose-950/75 border border-rose-500/40 text-xs text-rose-200 max-w-md">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-zinc-950 overflow-hidden flex items-center justify-center p-5">
      <div
        className="w-full h-full flex items-center justify-center transition-transform duration-100 [&_svg]:max-w-full [&_svg]:max-h-full [&_svg]:w-auto [&_svg]:h-auto"
        style={{ transform: `scale(${zoom})` }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />

      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 px-1.5 py-1 rounded-full bg-zinc-900/90 border border-white/10 backdrop-blur-md text-[11px]">
        <button
          onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}
          className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/10"
          title="Zoom Out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setZoom(1)}
          className="px-1.5 text-zinc-300 hover:text-emerald-300 font-mono text-[10px]"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.15).toFixed(2)))}
          className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/10"
          title="Zoom In"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

/* ============================================================================
 * 5. INTERACTIVE HIDPI CANVAS CHART ENGINE
 * ============================================================================ */

interface ChartDatasetSpec {
  label: string;
  data: number[];
  color?: string;
}

interface ChartSpec {
  type: "line" | "bar" | "area" | "scatter";
  labels: string[];
  datasets: ChartDatasetSpec[];
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
}

function parseChartSpec(rawCode: string): { spec: ChartSpec | null; error: string | null } {
  const cleaned = stripCodeFences(rawCode);
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object") {
      return { spec: null, error: "Chart specification must be a JSON object." };
    }
    const rawType = String(parsed.type || "line").toLowerCase();
    const type: ChartSpec["type"] =
      rawType === "bar" || rawType === "area" || rawType === "scatter"
        ? rawType
        : "line";
    const datasets: ChartDatasetSpec[] = Array.isArray(parsed.datasets)
      ? parsed.datasets
          .filter((d: unknown) => d && typeof d === "object" && Array.isArray((d as ChartDatasetSpec).data))
          .map((d: ChartDatasetSpec, idx: number) => ({
            label: String(d.label || `Series ${idx + 1}`),
            data: d.data.map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0)),
            color: d.color || CHART_PALETTE[idx % CHART_PALETTE.length],
          }))
      : [];

    if (datasets.length === 0) {
      return { spec: null, error: "Chart JSON must include at least one dataset with numeric data." };
    }

    const maxLen = Math.max(...datasets.map((d) => d.data.length), 1);
    const labels: string[] = Array.isArray(parsed.labels)
      ? parsed.labels.map((l: unknown) => String(l))
      : Array.from({ length: maxLen }, (_, i) => String(i + 1));

    return {
      spec: {
        type,
        labels,
        datasets,
        subtitle: typeof parsed.subtitle === "string" ? parsed.subtitle : undefined,
        xLabel: typeof parsed.xLabel === "string" ? parsed.xLabel : undefined,
        yLabel: typeof parsed.yLabel === "string" ? parsed.yLabel : undefined,
      },
      error: null,
    };
  } catch (e) {
    return {
      spec: null,
      error: `Invalid chart JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function niceTickStep(range: number, targetTicks: number): number {
  if (range <= 0) return 1;
  const rough = range / Math.max(2, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = norm <= 1.2 ? 1 : norm <= 2.5 ? 2 : norm <= 5.5 ? 5 : 10;
  return step * mag;
}

function formatAxisNumber(val: number): string {
  if (Math.abs(val) >= 1000) return `${(val / 1000).toFixed(1)}k`;
  if (Math.abs(val) < 0.0001) return "0";
  if (Number.isInteger(val)) return String(val);
  return Math.abs(val) < 10 ? val.toFixed(2).replace(/0$/, "") : val.toFixed(1);
}

const ChartEngine: React.FC<{ code: string; reloadKey: number }> = ({
  code,
  reloadKey,
}) => {
  const { spec, error } = useMemo(() => parseChartSpec(code), [code]);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hiddenSet, setHiddenSet] = useState<Set<number>>(new Set());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 500, h: 300 });
  const [animProgress, setAnimProgress] = useState(0);

  // Reset hidden series & run smooth entry animation on code/reload change
  useEffect(() => {
    setHiddenSet(new Set());
    setHoverIdx(null);
    let rafId = 0;
    const start = performance.now();
    const duration = 560;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setAnimProgress(eased);
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      }
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [code, reloadKey]);

  // Track canvas container dimensions cleanly
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 10 && rect.height > 10) {
        setSize({ w: rect.width, h: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [spec]);

  const layout = useMemo(() => {
    const padL = 52;
    const padR = 22;
    const padT = 18;
    const padB = spec?.xLabel ? 46 : 32;
    const plotW = Math.max(40, size.w - padL - padR);
    const plotH = Math.max(40, size.h - padT - padB);
    return { padL, padR, padT, padB, plotW, plotH };
  }, [size, spec?.xLabel]);

  const bounds = useMemo(() => {
    if (!spec) return { minY: 0, maxY: 1, stepY: 0.25 };
    const visible = spec.datasets.filter((_, i) => !hiddenSet.has(i));
    const active = visible.length > 0 ? visible : spec.datasets;
    let rawMin = Infinity;
    let rawMax = -Infinity;
    active.forEach((ds) => {
      ds.data.forEach((v) => {
        if (v < rawMin) rawMin = v;
        if (v > rawMax) rawMax = v;
      });
    });
    if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
      return { minY: 0, maxY: 1, stepY: 0.25 };
    }
    if (spec.type === "bar" && rawMin > 0) rawMin = 0;
    if (rawMin >= 0 && rawMin < rawMax * 0.25) rawMin = 0;
    if (rawMin === rawMax) {
      rawMin -= 1;
      rawMax += 1;
    }
    const pad = (rawMax - rawMin) * 0.1;
    const stepY = niceTickStep(rawMax - rawMin + pad, 5);
    const minY = Math.floor(rawMin / stepY) * stepY;
    const maxY = Math.ceil((rawMax + pad * 0.6) / stepY) * stepY;
    return { minY, maxY, stepY };
  }, [spec, hiddenSet]);

  // Draw crisp HiDPI chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spec) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { padL, padT, plotW, plotH } = layout;
    const { minY, maxY, stepY } = bounds;
    const ySpan = Math.max(1e-6, maxY - minY);
    const count = Math.max(spec.labels.length, ...spec.datasets.map((d) => d.data.length), 1);

    const xForIndex = (i: number) => {
      if (spec.type === "bar") {
        const slot = plotW / Math.max(1, count);
        return padL + slot * (i + 0.5);
      }
      if (count <= 1) return padL + plotW / 2;
      return padL + (i / (count - 1)) * plotW;
    };

    const yForVal = (v: number) => padT + plotH - ((v - minY) / ySpan) * plotH;

    ctx.clearRect(0, 0, size.w, size.h);

    // 1. Horizontal gridlines + Y labels
    ctx.save();
    ctx.font = "500 10.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = minY; v <= maxY + stepY * 0.01; v += stepY) {
      const y = yForVal(v);
      ctx.strokeStyle =
        Math.abs(v) < 1e-6 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.065)";
      ctx.lineWidth = 1;
      ctx.setLineDash(Math.abs(v) < 1e-6 ? [] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();

      ctx.fillStyle = "#71717a";
      ctx.fillText(formatAxisNumber(v), padL - 8, y);
    }
    ctx.setLineDash([]);
    ctx.restore();

    // Subtle target reference line at y = 1.0 when telemetry is normalized (e.g., 0..1.35)
    if (minY <= 0 && maxY > 1.02 && maxY <= 1.8) {
      const yTarget = yForVal(1.0);
      ctx.save();
      ctx.strokeStyle = "rgba(16, 185, 129, 0.32)";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(padL, yTarget);
      ctx.lineTo(padL + plotW, yTarget);
      ctx.stroke();
      ctx.fillStyle = "rgba(52, 211, 153, 0.75)";
      ctx.font = "600 9.5px Inter, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("TARGET 1.0", padL + plotW - 4, yTarget - 6);
      ctx.restore();
    }

    // 2. Axes lines
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.restore();

    // 3. X-axis labels (auto-decimated to prevent overlap)
    ctx.save();
    ctx.font = "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#71717a";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const maxLabels = Math.max(2, Math.floor(plotW / 56));
    const labelStride = Math.max(1, Math.ceil(count / maxLabels));
    for (let i = 0; i < count; i++) {
      if (i % labelStride !== 0 && i !== count - 1) continue;
      const lbl = spec.labels[i] ?? String(i + 1);
      ctx.fillText(lbl, xForIndex(i), padT + plotH + 8);
    }
    if (spec.xLabel) {
      ctx.fillStyle = "#a1a1aa";
      ctx.font = "600 10.5px Inter, system-ui, sans-serif";
      ctx.fillText(spec.xLabel, padL + plotW / 2, padT + plotH + 26);
    }
    if (spec.yLabel) {
      ctx.save();
      ctx.translate(13, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#a1a1aa";
      ctx.font = "600 10.5px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(spec.yLabel, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // 4. Datasets
    const visibleDatasets = spec.datasets
      .map((ds, origIdx) => ({ ds, origIdx }))
      .filter(({ origIdx }) => !hiddenSet.has(origIdx));

    if (spec.type === "bar") {
      const slot = plotW / Math.max(1, count);
      const groupPad = Math.min(14, slot * 0.22);
      const barGroupW = Math.max(6, slot - groupPad);
      const barW = Math.max(4, barGroupW / Math.max(1, visibleDatasets.length) - 3);
      const baseLineY = yForVal(Math.max(minY, Math.min(maxY, 0)));

      visibleDatasets.forEach(({ ds }, vIdx) => {
        const color = ds.color || CHART_PALETTE[vIdx % CHART_PALETTE.length];
        ds.data.forEach((rawVal, i) => {
          const val = rawVal * animProgress;
          const cx = xForIndex(i) - barGroupW / 2 + vIdx * (barW + 3);
          const yTop = yForVal(Math.max(0, val));
          const yBot = yForVal(Math.min(0, val));
          const h = Math.max(1, Math.abs(yBot - yTop));

          const grad = ctx.createLinearGradient(0, yTop, 0, yBot);
          grad.addColorStop(0, color);
          grad.addColorStop(1, `${color}33`);

          ctx.save();
          ctx.fillStyle = grad;
          ctx.strokeStyle = color;
          ctx.lineWidth = hoverIdx === i ? 1.8 : 1;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(cx, Math.min(yTop, baseLineY), barW, h, [4, 4, 0, 0]);
          } else {
            ctx.rect(cx, Math.min(yTop, baseLineY), barW, h);
          }
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        });
      });
    } else if (spec.type === "scatter") {
      visibleDatasets.forEach(({ ds }, vIdx) => {
        const color = ds.color || CHART_PALETTE[vIdx % CHART_PALETTE.length];
        ds.data.forEach((rawVal, i) => {
          const x = xForIndex(i);
          const y = yForVal(minY + (rawVal - minY) * animProgress);
          const isHot = hoverIdx === i;
          ctx.save();
          ctx.fillStyle = `${color}55`;
          ctx.strokeStyle = color;
          ctx.lineWidth = isHot ? 2.4 : 1.6;
          ctx.shadowColor = color;
          ctx.shadowBlur = isHot ? 14 : 6;
          ctx.beginPath();
          ctx.arc(x, y, isHot ? 6.5 : 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        });
      });
    } else {
      // Smooth "line" or "area"
      visibleDatasets.forEach(({ ds }, vIdx) => {
        const color = ds.color || CHART_PALETTE[vIdx % CHART_PALETTE.length];
        const pts = ds.data.map((rawVal, i) => ({
          x: xForIndex(i),
          y: yForVal(minY + (rawVal - minY) * animProgress),
        }));
        if (pts.length === 0) return;

        const traceSmoothPath = () => {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          if (pts.length === 2) {
            ctx.lineTo(pts[1].x, pts[1].y);
            return;
          }
          for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[Math.max(0, i - 1)];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = pts[Math.min(pts.length - 1, i + 2)];
            const cp1x = p1.x + (p2.x - p0.x) / 6;
            const cp1y = p1.y + (p2.y - p0.y) / 6;
            const cp2x = p2.x - (p3.x - p1.x) / 6;
            const cp2y = p2.y - (p3.y - p1.y) / 6;
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
          }
        };

        // Gradient fill underneath
        ctx.save();
        traceSmoothPath();
        ctx.lineTo(pts[pts.length - 1].x, padT + plotH);
        ctx.lineTo(pts[0].x, padT + plotH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, spec.type === "area" ? `${color}48` : `${color}24`);
        grad.addColorStop(1, `${color}00`);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        // Crisp glowing curve stroke
        ctx.save();
        traceSmoothPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.4;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.restore();

        // Data nodes
        pts.forEach((pt, i) => {
          const isHot = hoverIdx === i;
          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, isHot ? 5.2 : 2.6, 0, Math.PI * 2);
          ctx.fillStyle = isHot ? "#09090b" : color;
          ctx.strokeStyle = color;
          ctx.lineWidth = isHot ? 2.5 : 1;
          if (isHot) {
            ctx.shadowColor = color;
            ctx.shadowBlur = 12;
          }
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        });
      });
    }

    // 5. Hover vertical crosshair line
    if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < count) {
      const cx = xForIndex(hoverIdx);
      ctx.save();
      ctx.strokeStyle = "rgba(52, 211, 153, 0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, padT + plotH);
      ctx.stroke();
      ctx.restore();
    }
  }, [spec, size, layout, bounds, hiddenSet, hoverIdx, animProgress]);

  if (error || !spec) {
    return (
      <div className="p-4 h-full bg-zinc-950 flex items-center justify-center">
        <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-rose-950/75 border border-rose-500/40 text-xs text-rose-200 max-w-md">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span className="font-mono">{error || "Unable to render chart."}</span>
        </div>
      </div>
    );
  }

  const count = Math.max(spec.labels.length, ...spec.datasets.map((d) => d.data.length), 1);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (
      mx < layout.padL - 8 ||
      mx > layout.padL + layout.plotW + 8 ||
      my < layout.padT - 8 ||
      my > layout.padT + layout.plotH + 8
    ) {
      setHoverIdx(null);
      return;
    }

    const rel = Math.max(0, Math.min(1, (mx - layout.padL) / layout.plotW));
    const idx =
      spec.type === "bar"
        ? Math.min(count - 1, Math.floor(rel * count))
        : Math.round(rel * Math.max(0, count - 1));
    setHoverIdx(idx);
    setHoverPos({ x: mx, y: my });
  };

  const toggleSeries = (idx: number) => {
    setHiddenSet((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else if (next.size < spec.datasets.length - 1) {
        next.add(idx);
      }
      return next;
    });
  };

  const tooltipFlipLeft = hoverPos.x > size.w * 0.62;

  return (
    <div className="w-full h-full bg-zinc-950 flex flex-col p-3.5 gap-2 overflow-hidden">
      {/* Top Subtitle + Clickable Interactive Legend */}
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        {spec.subtitle ? (
          <span className="text-[11px] text-zinc-400 truncate">
            {spec.subtitle}
          </span>
        ) : (
          <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
            {spec.type} telemetry
          </span>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {spec.datasets.map((ds, idx) => {
            const hidden = hiddenSet.has(idx);
            const color = ds.color || CHART_PALETTE[idx % CHART_PALETTE.length];
            return (
              <button
                key={`${ds.label}-${idx}`}
                onClick={() => toggleSeries(idx)}
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-all ${
                  hidden
                    ? "bg-zinc-900/60 border-white/5 text-zinc-500 opacity-50 line-through"
                    : "bg-zinc-900/90 border-white/10 text-zinc-200 hover:border-white/25"
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span>{ds.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Canvas Plot + Hover Tooltip */}
      <div ref={wrapperRef} className="relative flex-1 min-h-0 w-full">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
          className="w-full h-full block cursor-crosshair"
        />

        {hoverIdx !== null && (
          <div
            className="pointer-events-none absolute top-3 z-20 min-w-[164px] px-3 py-2 rounded-xl bg-zinc-950/95 border border-emerald-400/40 shadow-[0_10px_30px_rgba(0,0,0,0.75)] backdrop-blur-md text-[11px]"
            style={{
              left: tooltipFlipLeft
                ? Math.max(8, hoverPos.x - 184)
                : Math.min(size.w - 176, hoverPos.x + 14),
            }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300 mb-1.5 border-b border-white/10 pb-1">
              {spec.labels[hoverIdx] ?? `Point #${hoverIdx + 1}`}
            </div>
            <div className="flex flex-col gap-1">
              {spec.datasets.map((ds, idx) => {
                if (hiddenSet.has(idx)) return null;
                const val = ds.data[hoverIdx];
                if (val === undefined) return null;
                const color = ds.color || CHART_PALETTE[idx % CHART_PALETTE.length];
                return (
                  <div
                    key={`${ds.label}-${idx}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="flex items-center gap-1.5 text-zinc-300 truncate">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span className="truncate max-w-[120px]">{ds.label}</span>
                    </span>
                    <span className="font-mono font-semibold text-white">
                      {formatAxisNumber(val)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ============================================================================
 * 6. 3BLUE1BROWN-STYLE MANIM CINEMATIC ANIMATION ENGINE
 * ============================================================================ */

const MANIM_SPEEDS = [0.5, 1, 1.5] as const;

function formatManimTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalSec = Math.floor(safe);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const ManimEngine: React.FC<{
  code: string;
  reloadKey: number;
  activeCue?: OverlayVizCueEvent | null;
}> = ({ code, reloadKey, activeCue = null }) => {
  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayLayerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ManimController | null>(null);

  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activeBeatIndex, setActiveBeatIndex] = useState(0);
  const [sceneSubtitle, setSceneSubtitle] = useState("");
  const [beats, setBeats] = useState<ManimBeatInfo[]>([]);
  const [speed, setSpeed] = useState<number>(1);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cueCaption, setCueCaption] = useState<{
    beatIndex: number;
    text: string;
  } | null>(null);

  const speedRef = useRef(speed);
  speedRef.current = speed;
  const prevBeatRef = useRef<number>(0);
  const lastCueSeqRef = useRef<number | null>(null);

  // Reset playback speed to 1x when a new animation script arrives
  useEffect(() => {
    setSpeed(1);
    speedRef.current = 1;
  }, [code]);

  // Mount Manim scene + ResizeObserver + clean disposal
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlayLayer = overlayLayerRef.current;
    const host = stageHostRef.current;
    if (!canvas || !overlayLayer || !host) return;

    setErrorMsg(null);
    setCueCaption(null);
    setPlaying(true);
    setTime(0);
    setActiveBeatIndex(0);
    setSceneSubtitle("");
    setBeats([]);
    prevBeatRef.current = 0;
    overlayLayer.innerHTML = "";

    let receivedState = false;
    let controller: ManimController | null = null;

    try {
      controller = mountManimScene({
        canvas,
        overlayLayer,
        code: stripCodeFences(code),
        onStateChange: (state) => {
          receivedState = true;
          setPlaying(state.playing);
          setTime(state.time);
          setDuration(state.duration);
          setActiveBeatIndex(state.activeBeatIndex);
          setSceneSubtitle(state.subtitle || "");

          if (prevBeatRef.current !== state.activeBeatIndex) {
            prevBeatRef.current = state.activeBeatIndex;
            setCueCaption((prev) =>
              prev && prev.beatIndex !== state.activeBeatIndex ? null : prev
            );
          }

          setBeats((prev) => {
            if (
              prev.length === state.beats.length &&
              prev.every(
                (b, idx) =>
                  b.index === state.beats[idx].index &&
                  b.title === state.beats[idx].title &&
                  b.subtitle === state.beats[idx].subtitle &&
                  b.startTime === state.beats[idx].startTime &&
                  b.duration === state.beats[idx].duration
              )
            ) {
              return prev;
            }
            return state.beats;
          });
        },
        onError: (message) => {
          setErrorMsg(message);
        },
      });

      controllerRef.current = controller;

      if (speedRef.current !== 1) {
        controller.setSpeed(speedRef.current);
      }

      if (!receivedState) {
        const initBeats = controller.getBeats();
        const initDur = controller.getDuration();
        const initTime = controller.getTime();
        setBeats(initBeats);
        setDuration(initDur);
        setTime(initTime);
        if (initBeats[0]?.subtitle) {
          setSceneSubtitle(initBeats[0].subtitle);
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }

    const resizeObserver = new ResizeObserver(() => {
      controller?.resize();
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      controllerRef.current = null;
      try {
        controller?.dispose();
      } catch {
        // Safe teardown
      }
      overlayLayer.innerHTML = "";
    };
  }, [code, reloadKey]);

  // Voice-synced [CUE:N] beat advancement from Sticky TTS
  useEffect(() => {
    if (!activeCue) {
      lastCueSeqRef.current = null;
      setCueCaption(null);
      return;
    }
    if (activeCue.seq === lastCueSeqRef.current) return;
    lastCueSeqRef.current = activeCue.seq;

    const ctrl = controllerRef.current;
    const currentBeats = ctrl?.getBeats() ?? [];
    const targetBeatIndex =
      currentBeats.length > 0
        ? Math.max(0, Math.min(currentBeats.length - 1, activeCue.index))
        : activeCue.index;

    if (activeCue.caption && activeCue.caption.trim()) {
      setCueCaption({
        beatIndex: targetBeatIndex,
        text: activeCue.caption.trim(),
      });
    } else {
      setCueCaption(null);
    }

    ctrl?.jumpToBeat(activeCue.index);
  }, [activeCue]);

  const handleTogglePlay = () => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    if (playing) {
      ctrl.pause();
    } else {
      const dur = ctrl.getDuration();
      const cur = ctrl.getTime();
      if (dur > 0 && cur >= dur - 0.05) {
        setCueCaption(null);
        ctrl.restart();
      } else {
        ctrl.play();
      }
    }
  };

  const handleRestart = () => {
    setCueCaption(null);
    controllerRef.current?.restart();
  };

  const handleCycleSpeed = () => {
    const idx = MANIM_SPEEDS.indexOf(speed as (typeof MANIM_SPEEDS)[number]);
    const next = MANIM_SPEEDS[(idx + 1) % MANIM_SPEEDS.length];
    setSpeed(next);
    controllerRef.current?.setSpeed(next);
  };

  const handleJumpToBeat = (beatIndex: number) => {
    setCueCaption(null);
    controllerRef.current?.jumpToBeat(beatIndex);
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(e.target.value);
    if (!Number.isFinite(nextTime)) return;
    setCueCaption(null);
    setTime(nextTime);
    controllerRef.current?.seek(nextTime);
  };

  const safeDuration = Math.max(duration, 0.01);
  const clampedTime = Math.max(0, Math.min(safeDuration, time));
  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (clampedTime / duration) * 100)) : 0;

  const activeBeat =
    beats.find((b) => b.index === activeBeatIndex) ?? beats[activeBeatIndex];
  const displaySubtitle =
    cueCaption?.text || sceneSubtitle || activeBeat?.subtitle || "";

  return (
    <div className="relative w-full h-full bg-[#080c14] flex flex-col overflow-hidden select-none">
      {/* Full-Bleed Dark Mathematical Canvas + KaTeX MathTex Overlay Layer */}
      <div
        ref={stageHostRef}
        onClick={handleTogglePlay}
        className="relative flex-1 min-h-0 w-full bg-[#080c14] overflow-hidden cursor-pointer"
      >
        <canvas ref={canvasRef} className="block w-full h-full" />
        <div
          ref={overlayLayerRef}
          className="absolute inset-0 pointer-events-none overflow-hidden text-zinc-100"
        />

        {/* Inline non-crashing error banner for LLM-generated scripts */}
        {errorMsg && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-3 left-3 right-3 z-20 flex items-start gap-2 px-3 py-2 rounded-xl bg-rose-950/90 border border-rose-500/45 text-[11px] text-rose-200 backdrop-blur-md shadow-[0_10px_28px_rgba(0,0,0,0.65)] cursor-default"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-rose-300 mb-0.5">
                Manim Scene Error
              </div>
              <span className="font-mono break-all leading-snug">{errorMsg}</span>
            </div>
          </div>
        )}
      </div>

      {/* 3Blue1Brown Cinematic Player Bar */}
      <div className="shrink-0 z-10 px-3 pt-2 pb-2.5 bg-gradient-to-t from-[#05080f] via-[#080c14]/[0.97] to-[#0a101c]/95 border-t border-white/[0.08] backdrop-blur-xl flex flex-col gap-2">
        {/* Live Narrated Subtitle Strip */}
        {displaySubtitle && (
          <div
            className={`px-3 py-1.5 rounded-xl border backdrop-blur-md flex items-center justify-center gap-2 transition-colors ${
              cueCaption
                ? "bg-emerald-500/[0.08] border-emerald-400/35 shadow-[0_0_16px_rgba(16,185,129,0.12)]"
                : "bg-white/[0.035] border-white/[0.08]"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                cueCaption
                  ? "bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]"
                  : "bg-indigo-400/80"
              }`}
            />
            <p className="text-[11.5px] leading-snug font-medium text-zinc-100 text-center line-clamp-2">
              {displaySubtitle}
            </p>
          </div>
        )}

        {/* Clickable Beat Chapter Pills */}
        {beats.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {beats.map((beat, idx) => {
              const isActive = beat.index === activeBeatIndex;
              const label = /^\d+[.)]\s/.test(beat.title)
                ? beat.title
                : `${idx + 1}. ${beat.title}`;
              return (
                <button
                  key={`${beat.index}-${beat.title}`}
                  onClick={() => handleJumpToBeat(beat.index)}
                  className={`shrink-0 px-2.5 py-1 rounded-full text-[10.5px] font-semibold border transition-all duration-150 ${
                    isActive
                      ? "bg-emerald-500/20 text-emerald-200 border-emerald-400/60 shadow-[0_0_14px_rgba(16,185,129,0.38)]"
                      : "bg-white/[0.03] text-zinc-400 border-white/10 hover:text-zinc-100 hover:bg-white/[0.08] hover:border-white/20"
                  }`}
                  title={beat.subtitle || beat.title}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {/* Transport Controls Row */}
        <div className="flex items-center gap-2 pr-4">
          {/* Play / Pause */}
          <button
            onClick={handleTogglePlay}
            className="w-7 h-7 rounded-full flex items-center justify-center bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-400/45 shadow-[0_0_10px_rgba(16,185,129,0.22)] transition-colors shrink-0"
            title={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="w-3.5 h-3.5" />
            ) : (
              <Play className="w-3.5 h-3.5 ml-0.5" />
            )}
          </button>

          {/* Replay */}
          <button
            onClick={handleRestart}
            className="w-7 h-7 rounded-full flex items-center justify-center bg-white/[0.05] hover:bg-white/[0.11] text-zinc-300 hover:text-white border border-white/10 transition-colors shrink-0"
            title="Replay from Start"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {/* Interactive Timeline Range Scrubber with Beat Chapter Markers */}
          <div className="relative flex-1 h-5 flex items-center group">
            <div className="relative w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-indigo-400 shadow-[0_0_10px_rgba(16,185,129,0.55)]"
                style={{ width: `${progressPct}%` }}
              />
              {duration > 0 &&
                beats.slice(1).map((b) => {
                  const pct = Math.max(0, Math.min(100, (b.startTime / duration) * 100));
                  return (
                    <span
                      key={`tick-${b.index}`}
                      className="absolute top-0 bottom-0 w-[1.5px] bg-[#080c14]/90 pointer-events-none"
                      style={{ left: `${pct}%` }}
                    />
                  );
                })}
            </div>

            <div
              className="pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-emerald-300 border-2 border-[#080c14] shadow-[0_0_10px_rgba(52,211,153,0.9)] transition-transform duration-100 group-hover:scale-125"
              style={{ left: `${progressPct}%` }}
            />

            <input
              type="range"
              min={0}
              max={safeDuration}
              step={0.01}
              value={clampedTime}
              onChange={handleScrub}
              aria-label="Animation timeline scrubber"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer m-0"
            />
          </div>

          {/* Formatted Timestamp */}
          <span className="font-mono text-[10.5px] tabular-nums text-zinc-300 shrink-0 min-w-[68px] text-right">
            {formatManimTime(clampedTime)} / {formatManimTime(duration)}
          </span>

          {/* Speed Toggle (0.5x -> 1x -> 1.5x) */}
          <button
            onClick={handleCycleSpeed}
            className={`px-2 py-0.5 rounded-md font-mono text-[10.5px] font-semibold border transition-colors shrink-0 ${
              speed !== 1
                ? "bg-indigo-500/20 text-indigo-200 border-indigo-400/45"
                : "bg-white/[0.05] text-zinc-300 border-white/10 hover:text-white hover:bg-white/[0.11]"
            }`}
            title="Cycle Playback Speed (0.5× / 1× / 1.5×)"
          >
            {speed}×
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * MAIN STAGE COMPONENT (DRAGGABLE, RESIZABLE, CODE INSPECTOR, LOADING CARD)
 * ============================================================================ */

export const VisualizationStage: React.FC<VisualizationStageProps> = ({
  viz,
  loading = null,
  activeCue = null,
  onClose,
  onRectChange,
}) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);

  const computeDefaultGeometry = useCallback(
    (wRaw?: number, hRaw?: number, kind?: VizKind | string) => {
      const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
      const vh = typeof window !== "undefined" ? window.innerHeight : 720;
      const maxW = Math.max(360, vw - 40);
      const maxH = Math.max(280, vh - 80);
      const defaultW = kind === "anim" ? 600 : 560;
      const defaultH = kind === "anim" ? 450 : 400;
      const w = Math.min(maxW, Math.max(360, wRaw ?? defaultW));
      const h = Math.min(maxH, Math.max(280, hRaw ?? defaultH));
      const x = Math.max(40, Math.min(vw - w - 20, vw - w - 60));
      const y = Math.max(24, Math.min(vh - h - 24, 84));
      return { x, y, w, h };
    },
    []
  );

  const [geom, setGeom] = useState(() =>
    computeDefaultGeometry(viz?.width, viz?.height, viz?.kind)
  );
  const prevGeomRef = useRef(geom);

  // Re-initialize geometry cleanly when a new visualization arrives
  useEffect(() => {
    if (!viz) return;
    setIsExpanded(false);
    setShowCode(false);
    setGeom(computeDefaultGeometry(viz.width, viz.height, viz.kind));
  }, [viz?.id, viz?.kind, viz?.title, viz?.width, viz?.height, computeDefaultGeometry]);

  // Keep stage inside viewport when OS window resizes
  useEffect(() => {
    const handleWindowResize = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      setGeom((prev) => {
        const w = Math.min(Math.max(360, vw - 40), prev.w);
        const h = Math.min(Math.max(280, vh - 80), prev.h);
        const x = Math.max(12, Math.min(vw - w - 12, prev.x));
        const y = Math.max(12, Math.min(vh - 64, prev.y));
        return { x, y, w, h };
      });
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  // Report live DOMRect for 60fps cursor hit-test controller
  const emitRect = useCallback(() => {
    if (!onRectChange) return;
    if ((!viz && !loading) || !stageRef.current) {
      onRectChange(null);
      return;
    }
    onRectChange(stageRef.current.getBoundingClientRect());
  }, [onRectChange, viz, loading]);

  useLayoutEffect(() => {
    emitRect();
    const el = stageRef.current;
    if (!el || (!viz && !loading)) {
      return () => onRectChange?.(null);
    }
    const ro = new ResizeObserver(() => emitRect());
    ro.observe(el);
    window.addEventListener("resize", emitRect);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", emitRect);
    };
  }, [emitRect, geom, isExpanded, viz, loading, onRectChange]);

  // Ensure unmount always clears rect
  useEffect(() => {
    return () => {
      onRectChange?.(null);
    };
  }, [onRectChange]);

  // Header drag handler
  const handleStartDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    e.preventDefault();
    setIsInteracting(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = geom.x;
    const origY = geom.y;
    const width = geom.w;

    const onMove = (ev: MouseEvent) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const nx = Math.max(12, Math.min(vw - width - 12, origX + (ev.clientX - startX)));
      const ny = Math.max(12, Math.min(vh - 60, origY + (ev.clientY - startY)));
      setGeom((prev) => ({ ...prev, x: nx, y: ny }));
    };

    const onUp = () => {
      setIsInteracting(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Bottom-right corner resize handler
  const handleStartResize = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsInteracting(true);
    setIsExpanded(false);

    const startX = e.clientX;
    const startY = e.clientY;
    const origW = geom.w;
    const origH = geom.h;

    const onMove = (ev: MouseEvent) => {
      const maxW = Math.max(360, window.innerWidth - 40);
      const maxH = Math.max(280, window.innerHeight - 80);
      const nw = Math.max(360, Math.min(maxW, origW + (ev.clientX - startX)));
      const nh = Math.max(280, Math.min(maxH, origH + (ev.clientY - startY)));
      setGeom((prev) => ({ ...prev, w: nw, h: nh }));
    };

    const onUp = () => {
      setIsInteracting(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleToggleExpand = () => {
    if (!isExpanded) {
      prevGeomRef.current = geom;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(980, Math.max(360, vw - 64));
      const h = Math.min(720, Math.max(280, vh - 104));
      setGeom({
        x: Math.max(20, Math.round((vw - w) / 2)),
        y: Math.max(24, Math.round((vh - h) / 2)),
        w,
        h,
      });
      setIsExpanded(true);
    } else {
      setGeom(prevGeomRef.current);
      setIsExpanded(false);
    }
  };

  const handleCopyCode = async () => {
    if (!viz?.code) return;
    try {
      await navigator.clipboard.writeText(viz.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard fallback ignored safely
    }
  };

  // Animated Loading Card when generating a visualization and `viz` hasn't arrived yet
  if (!viz && loading) {
    const loadX =
      typeof window !== "undefined"
        ? Math.max(40, window.innerWidth - 420 - 60)
        : 760;
    const badge = getEngineMeta(loading.kind);
    return (
      <div
        ref={stageRef}
        style={{ left: `${loadX}px`, top: "84px", width: "420px" }}
        className="fixed z-40 rounded-2xl bg-zinc-950/[0.92] border border-emerald-400/40 shadow-[0_20px_60px_rgba(0,0,0,0.75)] backdrop-blur-xl overflow-hidden pointer-events-auto select-none"
      >
        <div className="px-4 py-3.5 flex items-center gap-3">
          <div className="relative w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-400/40 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-emerald-300 animate-pulse" />
            <span className="absolute -inset-1 rounded-xl border border-emerald-400/30 animate-ping opacity-50" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${badge.badgeClass}`}
              >
                {badge.icon}
                {badge.label}
              </span>
              <span className="text-[11px] text-emerald-300/90 font-medium">
                Synthesizing live code…
              </span>
            </div>
            <p className="text-xs text-zinc-100 font-semibold truncate">
              Generating live {loading.kind} visualization: {loading.title}
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Animated emerald progress shimmer bar */}
        <div className="h-1 w-full bg-zinc-900 overflow-hidden">
          <div className="h-full w-1/2 bg-gradient-to-r from-transparent via-emerald-400 to-cyan-400 animate-pulse rounded-full" />
        </div>
      </div>
    );
  }

  if (!viz) return null;

  const meta = getEngineMeta(viz.kind);

  return (
    <div
      ref={stageRef}
      style={{
        left: `${geom.x}px`,
        top: `${geom.y}px`,
        width: `${geom.w}px`,
        height: `${geom.h}px`,
      }}
      className="fixed z-40 rounded-2xl bg-zinc-950/[0.92] border border-emerald-400/40 shadow-[0_20px_60px_rgba(0,0,0,0.75)] backdrop-blur-xl overflow-hidden flex flex-col pointer-events-auto select-none"
    >
      {/* Draggable Stage Header Bar */}
      <div
        onMouseDown={handleStartDrag}
        className="shrink-0 h-11 px-3.5 flex items-center justify-between gap-2 bg-zinc-900/85 border-b border-white/10 cursor-move"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_#10b981] shrink-0" />
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider shrink-0 ${meta.badgeClass}`}
          >
            {meta.icon}
            {meta.label}
          </span>
          <h3
            className="text-xs font-semibold text-zinc-100 truncate"
            title={viz.title}
          >
            {viz.title}
          </h3>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-emerald-300 hover:bg-white/10 transition-colors"
            title="Replay / Reload Visualization"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setShowCode((v) => !v)}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
              showCode
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/40"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-white/10"
            }`}
            title="Inspect / Copy Source Code"
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>Code</span>
          </button>

          <button
            onClick={handleToggleExpand}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/10 transition-colors"
            title={isExpanded ? "Restore Stage Size" : "Expand Stage"}
          >
            {isExpanded ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-400 hover:bg-rose-500/15 transition-colors"
            title="Close Visualization Stage (Esc)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Live Stage Content Area */}
      <div className="relative flex-1 min-h-0 w-full bg-zinc-950 overflow-hidden">
        {/* Render Active Engine */}
        {(viz.kind === "html" || viz.kind === "canvas") && (
          <HtmlCanvasEngine
            code={viz.code}
            kind={viz.kind}
            title={viz.title}
            reloadKey={reloadKey}
          />
        )}
        {viz.kind === "three" && (
          <ThreeEngine code={viz.code} reloadKey={reloadKey} />
        )}
        {viz.kind === "mermaid" && (
          <MermaidEngine code={viz.code} reloadKey={reloadKey} />
        )}
        {viz.kind === "svg" && (
          <SvgEngine code={viz.code} reloadKey={reloadKey} />
        )}
        {viz.kind === "chart" && (
          <ChartEngine code={viz.code} reloadKey={reloadKey} />
        )}
        {viz.kind === "anim" && (
          <ManimEngine
            code={viz.code}
            reloadKey={reloadKey}
            activeCue={activeCue}
          />
        )}

        {/* Transparent drag/resize shield so sandboxed iframes never steal pointer move */}
        {isInteracting && (
          <div className="absolute inset-0 z-30 cursor-grabbing bg-transparent" />
        )}

        {/* Code Inspector Drawer Overlay */}
        {showCode && (
          <div className="absolute inset-0 z-20 bg-zinc-950/95 backdrop-blur-md flex flex-col select-text">
            <div className="shrink-0 px-3.5 py-2 flex items-center justify-between border-b border-white/10 bg-zinc-900/75">
              <span className="text-[11px] font-mono text-zinc-400">
                source.{viz.kind === "three" || viz.kind === "anim" ? "js" : viz.kind === "chart" ? "json" : viz.kind} ·{" "}
                {viz.code.length.toLocaleString()} chars
              </span>
              <button
                onClick={handleCopyCode}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/35 text-emerald-300 text-[11px] font-medium transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy Code</span>
                  </>
                )}
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-[11.5px] leading-relaxed font-mono text-emerald-100/90 whitespace-pre">
              {viz.code}
            </pre>
          </div>
        )}

        {/* Bottom-Right Resize Grip Handle */}
        <div
          onMouseDown={handleStartResize}
          title="Drag to resize"
          className="absolute bottom-0 right-0 z-30 w-5 h-5 cursor-nwse-resize flex items-end justify-end p-1 group"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            className="text-zinc-500 group-hover:text-emerald-400 transition-colors"
          >
            <path
              d="M9 1L1 9M9 5L5 9M9 8.5L8.5 9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
};
