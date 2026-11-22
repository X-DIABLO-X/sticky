import React, { useState, useEffect, useCallback, useRef } from "react";
import { listenEvent, setIgnoreCursorEvents, invokeCommand } from "../lib/ipc";
import type {
  OverlayPointEvent,
  OverlayDrawEvent,
  Overlay3DEvent,
  OverlayVizEvent,
  OverlayVizLoadingEvent,
  OverlayVizCueEvent,
  VizKind,
  WalkthroughStep,
  DriveStatusEvent,
  DriveConfirmationPayload,
} from "../types/events";
import { DrawingCanvas } from "../components/overlay/DrawingCanvas";
import { GuidedStepBox } from "../components/overlay/GuidedStepBox";
import { DriveBorder } from "../components/overlay/DriveBorder";
import { Model3DViewer } from "../components/overlay/Model3DViewer";
import { CursorFollower } from "../components/overlay/CursorFollower";
import { VisualizationStage } from "../components/overlay/VisualizationStage";
import { DEMO_SKETCH_DRAWINGS, VIZ_PRESETS } from "../components/overlay/vizPresets";
import { StreamingTagParser } from "../lib/pointParser";
import {
  Sparkles,
  Navigation,
  Box,
  Pencil,
  Play,
  Activity,
  GitBranch,
  BarChart3,
  Trash2,
} from "lucide-react";

const HIT_TEST_PADDING_PX = 6;

export const OverlayWindow: React.FC = () => {
  const [point, setPoint] = useState<OverlayPointEvent | null>(null);
  const [drawings, setDrawings] = useState<OverlayDrawEvent[]>([]);
  const [clearDrawingsSignal, setClearDrawingsSignal] = useState(0);
  const [model3D, setModel3D] = useState<Overlay3DEvent | null>(null);
  const [vizEvent, setVizEvent] = useState<OverlayVizEvent | null>(null);
  const [vizLoading, setVizLoading] = useState<OverlayVizLoadingEvent | null>(null);
  const [vizCue, setVizCue] = useState<OverlayVizCueEvent | null>(null);
  const [walkthroughStep, setWalkthroughStep] = useState<WalkthroughStep | null>(null);
  const [walkthroughIndex, setWalkthroughIndex] = useState(0);
  const [walkthroughTotal, setWalkthroughTotal] = useState(0);
  const [driveStatus, setDriveStatus] = useState<DriveStatusEvent | null>(null);
  const [showDevControls, setShowDevControls] = useState(false);
  const [showFollower, setShowFollower] = useState(true);
  const [isTalking, setIsTalking] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [guideHud, setGuideHud] = useState<{
    active: boolean;
    step: number;
    goal: string;
    instruction: string;
  }>({ active: false, step: 0, goal: "", instruction: "" });

  // 60FPS Windows Interactive Hit-Test Controller refs
  const interactiveRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const isIgnoringCursorRef = useRef<boolean>(true);
  const isShiftDownRef = useRef<boolean>(false);
  const lastCursorRef = useRef<{ x: number; y: number }>({ x: -9999, y: -9999 });

  const devControlsRef = useRef<HTMLDivElement | null>(null);
  const model3DHostRef = useRef<HTMLDivElement | null>(null);
  const demoSketchTimerRef = useRef<number | null>(null);
  const cueSeqRef = useRef<number>(0);

  const evaluateHitTest = useCallback((mx: number, my: number) => {
    let insideAny = isShiftDownRef.current;

    if (!insideAny) {
      for (const rect of interactiveRectsRef.current.values()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (
          mx >= rect.left - HIT_TEST_PADDING_PX &&
          mx <= rect.right + HIT_TEST_PADDING_PX &&
          my >= rect.top - HIT_TEST_PADDING_PX &&
          my <= rect.bottom + HIT_TEST_PADDING_PX
        ) {
          insideAny = true;
          break;
        }
      }
    }

    const nextIgnore = !insideAny;
    if (nextIgnore !== isIgnoringCursorRef.current) {
      isIgnoringCursorRef.current = nextIgnore;
      setIgnoreCursorEvents(nextIgnore);
    }
  }, []);

  const registerInteractiveRect = useCallback(
    (key: string, rect: DOMRect | null) => {
      if (rect && rect.width > 0 && rect.height > 0) {
        interactiveRectsRef.current.set(key, rect);
      } else {
        interactiveRectsRef.current.delete(key);
      }
      evaluateHitTest(lastCursorRef.current.x, lastCursorRef.current.y);
    },
    [evaluateHitTest]
  );

  const handleVizRectChange = useCallback(
    (rect: DOMRect | null) => registerInteractiveRect("viz-stage", rect),
    [registerInteractiveRect]
  );

  const handleDrawingToolbarRect = useCallback(
    (rect: DOMRect | null) => registerInteractiveRect("drawing-toolbar", rect),
    [registerInteractiveRect]
  );

  const handleClearDrawings = useCallback(() => {
    if (demoSketchTimerRef.current !== null) {
      window.clearTimeout(demoSketchTimerRef.current);
      demoSketchTimerRef.current = null;
    }
    setDrawings([]);
    setClearDrawingsSignal((n) => n + 1);
  }, []);

  const handleClearTarget = useCallback(() => {
    setPoint(null);
  }, []);

  const handleCloseViz = useCallback(() => {
    setVizEvent(null);
    setVizLoading(null);
    setVizCue(null);
  }, []);

  const handleClearAll = useCallback(() => {
    if (demoSketchTimerRef.current !== null) {
      window.clearTimeout(demoSketchTimerRef.current);
      demoSketchTimerRef.current = null;
    }
    setPoint(null);
    setDrawings([]);
    setClearDrawingsSignal((n) => n + 1);
    setVizEvent(null);
    setVizLoading(null);
    setVizCue(null);
    setModel3D(null);
    setWalkthroughStep(null);
  }, []);

  const triggerDemoPreset = useCallback((rawPreset: string) => {
    const preset = (rawPreset || "").trim().toLowerCase();
    if (!preset) return;

    if (preset === "clear" || preset === "clear_all") {
      handleClearAll();
      return;
    }

    if (preset === "sketch_diagram") {
      if (demoSketchTimerRef.current !== null) {
        window.clearTimeout(demoSketchTimerRef.current);
      }
      // Clear first so DrawingCanvas's clearSignal effect runs before adding the fresh sketch
      setDrawings([]);
      setClearDrawingsSignal((n) => n + 1);
      const stamp = Date.now();
      demoSketchTimerRef.current = window.setTimeout(() => {
        demoSketchTimerRef.current = null;
        setDrawings(
          DEMO_SKETCH_DRAWINGS.map((d, idx) => ({
            ...d,
            id: `${d.id || "demo-sketch"}-${stamp}-${idx}`,
            persistent: true,
          }))
        );
      }, 24);
      return;
    }

    const found = VIZ_PRESETS[preset];
    if (found) {
      setVizLoading(null);
      setVizCue(null);
      setVizEvent({
        ...found,
        id: `${found.id}-${Date.now()}`,
      });
    }
  }, [handleClearAll]);

  // Register Dev Controls DOMRect continuously via ResizeObserver
  useEffect(() => {
    const el = devControlsRef.current;
    if (!el) {
      registerInteractiveRect("dev-controls", null);
      return;
    }
    const sync = () => registerInteractiveRect("dev-controls", el.getBoundingClientRect());
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      registerInteractiveRect("dev-controls", null);
    };
  }, [showDevControls, registerInteractiveRect]);

  // Register Model3DViewer DOMRect when active (including while dragged)
  useEffect(() => {
    if (!model3D || model3D.visible === false) {
      registerInteractiveRect("model-3d", null);
      return;
    }

    const sync = () => {
      const target = model3DHostRef.current?.firstElementChild;
      registerInteractiveRect(
        "model-3d",
        target ? target.getBoundingClientRect() : null
      );
    };

    sync();
    const host = model3DHostRef.current;
    const mo = host ? new MutationObserver(sync) : null;
    if (host && mo) {
      mo.observe(host, {
        attributes: true,
        subtree: true,
        childList: true,
        attributeFilter: ["style", "class"],
      });
    }
    const ro =
      host?.firstElementChild ? new ResizeObserver(sync) : null;
    if (host?.firstElementChild && ro) {
      ro.observe(host.firstElementChild);
    }
    window.addEventListener("resize", sync);

    return () => {
      mo?.disconnect();
      ro?.disconnect();
      window.removeEventListener("resize", sync);
      registerInteractiveRect("model-3d", null);
    };
  }, [model3D, registerInteractiveRect]);

  // 60FPS Windows cursor_pos hit-test controller + Shift-draw + Escape hotkey
  useEffect(() => {
    isIgnoringCursorRef.current = true;
    setIgnoreCursorEvents(true);

    const unlistenCursor = listenEvent<{ x: number; y: number }>(
      "cursor_pos",
      (data) => {
        if (!data) return;
        const dpr = window.devicePixelRatio || 1;
        const mx = data.x / dpr;
        const my = data.y / dpr;
        lastCursorRef.current = { x: mx, y: my };
        evaluateHitTest(mx, my);
      }
    );

    const handleLocalMouseMove = (e: MouseEvent) => {
      lastCursorRef.current = { x: e.clientX, y: e.clientY };
      evaluateHitTest(e.clientX, e.clientY);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        if (!isShiftDownRef.current) {
          isShiftDownRef.current = true;
          evaluateHitTest(lastCursorRef.current.x, lastCursorRef.current.y);
        }
      } else if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === "O") {
        setShowDevControls((prev) => !prev);
      } else if (e.key === "Escape") {
        handleClearDrawings();
        handleCloseViz();
        setPoint(null);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        isShiftDownRef.current = false;
        evaluateHitTest(lastCursorRef.current.x, lastCursorRef.current.y);
      }
    };

    const handleBlur = () => {
      if (isShiftDownRef.current) {
        isShiftDownRef.current = false;
        evaluateHitTest(lastCursorRef.current.x, lastCursorRef.current.y);
      }
    };

    window.addEventListener("mousemove", handleLocalMouseMove, { passive: true });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      unlistenCursor.then((u) => u());
      window.removeEventListener("mousemove", handleLocalMouseMove);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [evaluateHitTest, handleClearDrawings, handleCloseViz]);

  // Listen to backend overlay commands, demo showcase events, and runtime state
  useEffect(() => {
    const tagParser = new StreamingTagParser({
      onPoint: (p) => setPoint(p),
      onDraw: (d) => setDrawings((prev) => [...prev, d]),
      on3D: (m) => setModel3D(m),
      onStep: (step, cur, tot) => {
        setWalkthroughStep(step);
        setWalkthroughIndex(cur - 1);
        setWalkthroughTotal(tot);
      },
    });

    const unlistenCmd = listenEvent<any>("overlay:command", (cmd) => {
      if (!cmd) return;
      if (cmd.type === "Point" && cmd.payload) {
        setPoint({
          x: cmd.payload.x,
          y: cmd.payload.y,
          label: cmd.payload.label || "Target",
          durationMs: cmd.payload.durationMs ?? 460,
        });
      } else if (cmd.type === "Draw" && cmd.payload) {
        setDrawings((prev) => [
          ...prev,
          {
            id: cmd.payload.id || `draw_${Date.now()}_${Math.random()}`,
            shape: cmd.payload.shape || "box",
            coords: cmd.payload.coords || [200, 200, 400, 400],
            label: cmd.payload.label,
            color: cmd.payload.color || "#10b981",
            fadeMs: cmd.payload.fadeMs,
            persistent: cmd.payload.persistent,
            style: cmd.payload.style,
          },
        ]);
      } else if (cmd.type === "ClearDrawings") {
        setDrawings([]);
        setClearDrawingsSignal((n) => n + 1);
      } else if (cmd.type === "Model3D" && cmd.payload) {
        setModel3D({
          id: `3d_${Date.now()}`,
          title: cmd.payload.title || "3D Object",
          geometryType: (cmd.payload.model as any) || "robot",
          visible: true,
        });
      } else if (cmd.type === "Step" && cmd.payload) {
        setWalkthroughStep({
          step: cmd.payload.index || 1,
          instruction: cmd.payload.instruction || "",
          bbox: cmd.payload.bbox || [100, 100, 300, 300],
        });
        setWalkthroughIndex((cmd.payload.index || 1) - 1);
        setWalkthroughTotal(cmd.payload.total || 1);
      } else if (cmd.type === "VizLoading") {
        const p = cmd.payload || {};
        setVizEvent(null);
        setVizCue(null);
        setVizLoading({
          kind: p.kind || "html",
          title: p.title || "Interactive Visualization",
        });
      } else if (cmd.type === "VizRender" && cmd.payload) {
        const p = cmd.payload;
        setVizLoading(null);
        setVizCue(null);
        setVizEvent({
          id: p.id || `viz_${Date.now()}`,
          kind: (p.kind || "html") as VizKind,
          title: p.title || "Live Visualization",
          code: p.code || "",
          width: typeof p.width === "number" ? p.width : undefined,
          height: typeof p.height === "number" ? p.height : undefined,
        });
      } else if (cmd.type === "VizCue" && cmd.payload) {
        const idx =
          typeof cmd.payload.index === "number"
            ? cmd.payload.index
            : Number(cmd.payload.index);
        if (Number.isFinite(idx)) {
          setVizCue({
            index: idx,
            caption:
              typeof cmd.payload.caption === "string"
                ? cmd.payload.caption
                : undefined,
            seq: ++cueSeqRef.current,
          });
        }
      } else if (cmd.type === "VizClose") {
        setVizEvent(null);
        setVizLoading(null);
        setVizCue(null);
      }
    });

    const unlistenVizCue = listenEvent<{ index: number; caption?: string }>(
      "overlay:viz_cue",
      (payload) => {
        if (!payload) return;
        const idx =
          typeof payload.index === "number"
            ? payload.index
            : Number(payload.index);
        if (!Number.isFinite(idx)) return;
        setVizCue({
          index: idx,
          caption:
            typeof payload.caption === "string" ? payload.caption : undefined,
          seq: ++cueSeqRef.current,
        });
      }
    );

    const unlistenDemo = listenEvent<string | { preset?: string }>(
      "overlay:demo",
      (payload) => {
        if (typeof payload === "string") {
          triggerDemoPreset(payload);
        } else if (payload && typeof payload.preset === "string") {
          triggerDemoPreset(payload.preset);
        }
      }
    );

    const unlistenPointClear = listenEvent("overlay:point_clear", () => {
      setPoint(null);
    });

    const unlistenClearDrawings = listenEvent("overlay:clear_drawings", () => {
      setDrawings([]);
      setClearDrawingsSignal((n) => n + 1);
    });

    const unlistenGuideState = listenEvent<{
      active: boolean;
      step: number;
      goal: string;
      instruction: string;
    }>("guide:state", (payload) => {
      if (payload) {
        setGuideHud(payload);
      }
    });

    const unlistenDrive = listenEvent<DriveStatusEvent>("drive_status", (status) => {
      setDriveStatus(status);
    });

    const unlistenTalk = listenEvent<string>("talk:state", (state) => {
      const s = (state || "").toLowerCase();
      setIsTalking(s === "listening" || s === "speaking");
    });

    const unlistenDict = listenEvent<string>("dictation:state", (state) => {
      const s = (state || "").toLowerCase();
      setIsDictating(s === "recording" || s === "listening");
    });

    const unlistenStream = listenEvent<{ textChunk: string }>("ai_stream_chunk", (chunk) => {
      tagParser.feed(chunk.textChunk);
    });

    return () => {
      unlistenCmd.then((u) => u());
      unlistenVizCue.then((u) => u());
      unlistenDemo.then((u) => u());
      unlistenPointClear.then((u) => u());
      unlistenClearDrawings.then((u) => u());
      unlistenGuideState.then((u) => u());
      unlistenDrive.then((u) => u());
      unlistenTalk.then((u) => u());
      unlistenDict.then((u) => u());
      unlistenStream.then((u) => u());
    };
  }, [triggerDemoPreset]);

  // Drive action confirmations
  const handleApproveDrive = async (payload: DriveConfirmationPayload) => {
    await invokeCommand("confirm_tool_call", { toolCallId: payload.toolCallId });
    setDriveStatus((prev) => (prev ? { ...prev, requiresConfirmation: false } : null));
  };

  const handleRejectDrive = async (payload: DriveConfirmationPayload) => {
    await invokeCommand("reject_tool_call", { toolCallId: payload.toolCallId });
    setDriveStatus({ state: "aborted", actionDescription: "Aborted by user." });
  };

  const handleAbortDrive = async () => {
    await invokeCommand("abort_drive_mode");
    setDriveStatus({
      state: "aborted",
      actionDescription: "Watchdog triggered: Esc or Mouse move.",
    });
    setTimeout(() => setDriveStatus(null), 3000);
  };

  // Walkthrough step advancement
  const handleNextStep = () => {
    if (walkthroughIndex + 1 < walkthroughTotal) {
      setWalkthroughIndex((prev) => prev + 1);
    } else {
      setWalkthroughStep(null);
    }
  };

  const handlePrevStep = () => {
    if (walkthroughIndex > 0) {
      setWalkthroughIndex((prev) => prev - 1);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden select-none pointer-events-none bg-transparent">
      {/* Unified Single HeyClicky Emerald Cursor (User Follow + AI Pointing) */}
      <CursorFollower
        enabled={showFollower}
        talkActive={isTalking}
        dictationActive={isDictating}
        aiTarget={point}
        onClearTarget={handleClearTarget}
        guidedMode={guideHud.active || walkthroughStep !== null}
      />

      {/* 1. Expressive Rough.js Vector Whiteboard Canvas & Draw-to-Focus Capture */}
      <DrawingCanvas
        externalDrawings={drawings}
        clearSignal={clearDrawingsSignal}
        guidedMode={guideHud.active || walkthroughStep !== null}
        onScribbleFocusCrop={(bbox) => {
          console.log("Captured focus crop bbox:", bbox);
          invokeCommand("analyze_screen_region", { bbox });
        }}
        onClearAll={handleClearDrawings}
        onRegisterToolbarRect={handleDrawingToolbarRect}
      />

      {/* 2. HeyClicky-Grade Live Code Visualization Stage (HTML / Three.js / Mermaid / SVG / Chart / Manim Anim) */}
      <VisualizationStage
        viz={vizEvent}
        loading={vizLoading}
        activeCue={vizCue}
        onClose={handleCloseViz}
        onRectChange={handleVizRectChange}
      />

      {/* Live Step-by-Step Guide HUD Banner */}
      {guideHud.active && guideHud.instruction && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 max-w-xl px-4 py-2.5 rounded-2xl bg-zinc-950/90 border border-emerald-400/45 shadow-[0_8px_32px_rgba(0,0,0,0.65)] backdrop-blur-md pointer-events-none flex items-center gap-3">
          <span className="shrink-0 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/40 text-[11px] font-bold text-emerald-300 tracking-wide">
            STEP {guideHud.step}
          </span>
          <p className="text-xs font-medium text-zinc-100 leading-snug line-clamp-2">
            {guideHud.instruction}
          </p>
          <span className="shrink-0 text-[10px] text-zinc-400 border-l border-white/10 pl-2.5 whitespace-nowrap">
            Click target · Esc to exit
          </span>
        </div>
      )}

      {/* 3. Interactive Guided Walkthrough Target Box */}
      <GuidedStepBox
        step={walkthroughStep}
        currentStepIndex={walkthroughIndex}
        totalSteps={walkthroughTotal}
        onNext={handleNextStep}
        onPrev={handlePrevStep}
        onClose={() => setWalkthroughStep(null)}
      />

      {/* 4. Drive Mode Glowing Perimeter Border & Confirmation Modal */}
      <DriveBorder
        status={driveStatus}
        onConfirmAction={handleApproveDrive}
        onRejectAction={handleRejectDrive}
        onAbortDrive={handleAbortDrive}
      />

      {/* 5. Three.js 3D Interactive Spatial Object Viewer */}
      {model3D && model3D.visible && (
        <div ref={model3DHostRef} className="contents">
          <Model3DViewer model={model3D} onClose={() => setModel3D(null)} />
        </div>
      )}

      {/* Hidden Developer Sandbox Bar (Only visible when explicitly toggled via Ctrl+Shift+O — zero idle bottom-right icon) */}
      {showDevControls && (
        <div
          ref={devControlsRef}
          className="fixed bottom-3 right-3 z-50 pointer-events-auto"
        >
          <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-2xl bg-zinc-950/[0.92] border border-emerald-400/40 shadow-[0_14px_40px_rgba(0,0,0,0.75)] backdrop-blur-xl text-xs">
            <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider px-1.5">
              Showcase
            </span>

            {/* Sketch Diagram */}
            <button
              onClick={() => triggerDemoPreset("sketch_diagram")}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-400/35 transition-colors"
            >
              <Pencil className="w-3 h-3" /> Sketch
            </button>

            {/* Manim 3Blue1Brown Animation */}
            <button
              onClick={() => triggerDemoPreset("manim_gradient_descent")}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gradient-to-r from-emerald-500/20 to-indigo-500/25 hover:from-emerald-500/30 hover:to-indigo-500/35 text-emerald-200 border border-emerald-400/45 shadow-[0_0_10px_rgba(16,185,129,0.2)] transition-all"
            >
              <Play className="w-3 h-3 text-emerald-300" /> Manim
            </button>

            {/* Spring Physics Viz */}
            <button
              onClick={() => triggerDemoPreset("spring_vs_easing")}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-400/35 transition-colors"
            >
              <Activity className="w-3 h-3" /> Spring Viz
            </button>

            {/* Three.js 3D Scene */}
            <button
              onClick={() => triggerDemoPreset("three_subdiv_cube")}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-400/35 transition-colors"
            >
              <Box className="w-3 h-3" /> 3D Scene
            </button>

            {/* Mermaid Flowchart */}
            <button
              onClick={() => triggerDemoPreset("mermaid_flow")}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 border border-violet-400/35 transition-colors"
            >
              <GitBranch className="w-3 h-3" /> Mermaid
            </button>

            {/* Interactive Chart */}
            <button
              onClick={() => triggerDemoPreset("interactive_chart")}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-teal-500/15 hover:bg-teal-500/25 text-teal-300 border border-teal-400/35 transition-colors"
            >
              <BarChart3 className="w-3 h-3" /> Chart
            </button>

            {/* Test Point */}
            <button
              onClick={() => {
                const rx = Math.floor(Math.random() * 680) + 160;
                const ry = Math.floor(Math.random() * 440) + 140;
                setPoint({
                  x: Math.round((rx / window.innerWidth) * 1000),
                  y: Math.round((ry / window.innerHeight) * 1000),
                  label: "Target UI Element",
                  durationMs: 420,
                });
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-200 border border-white/10 transition-colors"
            >
              <Navigation className="w-3 h-3" /> Point
            </button>

            {/* Toggle Cursor Follower */}
            <button
              onClick={() => setShowFollower((v) => !v)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg border transition-colors ${
                showFollower
                  ? "bg-emerald-500/15 text-emerald-200 border-emerald-400/30"
                  : "bg-zinc-900 text-zinc-500 border-white/10"
              }`}
            >
              <Sparkles className="w-3 h-3" /> {showFollower ? "Cursor ON" : "Cursor OFF"}
            </button>

            {/* Clear All */}
            <button
              onClick={handleClearAll}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-400/35 transition-colors"
            >
              <Trash2 className="w-3 h-3" /> Clear All
            </button>

            <button
              onClick={() => setShowDevControls(false)}
              className="text-zinc-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
              title="Close Sandbox"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
