import React, { useState, useEffect, useCallback } from "react";
import { listenEvent, setIgnoreCursorEvents, invokeCommand } from "../lib/ipc";
import type {
  OverlayPointEvent,
  OverlayDrawEvent,
  Overlay3DEvent,
  WalkthroughStep,
  DriveStatusEvent,
  DriveConfirmationPayload,
} from "../types/events";
import { DrawingCanvas } from "../components/overlay/DrawingCanvas";
import { GuidedStepBox } from "../components/overlay/GuidedStepBox";
import { DriveBorder } from "../components/overlay/DriveBorder";
import { Model3DViewer } from "../components/overlay/Model3DViewer";
import { CursorFollower } from "../components/overlay/CursorFollower";
import { StreamingTagParser } from "../lib/pointParser";
import { Sparkles, Eye, ShieldAlert, Navigation, Edit3, Box } from "lucide-react";

export const OverlayWindow: React.FC = () => {
  const [point, setPoint] = useState<OverlayPointEvent | null>(null);
  const [drawings, setDrawings] = useState<OverlayDrawEvent[]>([]);
  const [clearDrawingsSignal, setClearDrawingsSignal] = useState(0);
  const [model3D, setModel3D] = useState<Overlay3DEvent | null>(null);
  const [walkthroughStep, setWalkthroughStep] = useState<WalkthroughStep | null>(null);
  const [walkthroughIndex, setWalkthroughIndex] = useState(0);
  const [walkthroughTotal, setWalkthroughTotal] = useState(0);
  const [driveStatus, setDriveStatus] = useState<DriveStatusEvent | null>(null);
  const [showDevControls, setShowDevControls] = useState(false);
  const [showFollower, setShowFollower] = useState(true);
  const [isTalking, setIsTalking] = useState(false);
  const [isDictating, setIsDictating] = useState(false);

  const handleClearDrawings = useCallback(() => {
    setDrawings([]);
    setClearDrawingsSignal((n) => n + 1);
  }, []);

  const handleClearTarget = useCallback(() => {
    setPoint(null);
  }, []);

  // Initialize click-through hit-testing on mount
  useEffect(() => {
    // Start with total click-through transparent mode
    setIgnoreCursorEvents(true);

    // Setup streaming tag parser
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

    // Listen for direct Rust backend IPC events
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
      }
    });

    const unlistenPointClear = listenEvent("overlay:point_clear", () => {
      setPoint(null);
    });

    const unlistenClearDrawings = listenEvent("overlay:clear_drawings", () => {
      setDrawings([]);
      setClearDrawingsSignal((n) => n + 1);
    });

    const unlistenPoint = listenEvent<OverlayPointEvent>("overlay_point", (p) => {
      setPoint(p);
    });

    const unlistenDraw = listenEvent<OverlayDrawEvent>("overlay_draw", (d) => {
      setDrawings((prev) => [...prev, d]);
    });

    const unlisten3D = listenEvent<Overlay3DEvent>("overlay_3d", (m) => {
      setModel3D(m);
    });

    const unlistenWalkthrough = listenEvent<{
      step: WalkthroughStep;
      current: number;
      total: number;
    }>("walkthrough_step", (payload) => {
      setWalkthroughStep(payload.step);
      setWalkthroughIndex(payload.current - 1);
      setWalkthroughTotal(payload.total);
    });

    const unlistenDrive = listenEvent<DriveStatusEvent>("drive_status", (status) => {
      setDriveStatus(status);
    });

    const unlistenTalk = listenEvent<string>("talk:state", (state) => {
      setIsTalking(state === "Listening" || state === "Speaking");
    });

    const unlistenDict = listenEvent<string>("dictation:state", (state) => {
      setIsDictating(state === "listening");
    });

    const unlistenStream = listenEvent<{ textChunk: string }>("ai_stream_chunk", (chunk) => {
      tagParser.feed(chunk.textChunk);
    });

    // Keyboard toggle for dev test toolbar (`Ctrl+Shift+O`)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "O") {
        setShowDevControls((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      unlistenCmd.then((u) => u());
      unlistenPointClear.then((u) => u());
      unlistenClearDrawings.then((u) => u());
      unlistenPoint.then((u) => u());
      unlistenDraw.then((u) => u());
      unlisten3D.then((u) => u());
      unlistenWalkthrough.then((u) => u());
      unlistenDrive.then((u) => u());
      unlistenTalk.then((u) => u());
      unlistenDict.then((u) => u());
      unlistenStream.then((u) => u());
    };
  }, []);

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
    setDriveStatus({ state: "aborted", actionDescription: "Watchdog triggered: Esc or Mouse move." });
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
        guidedMode={walkthroughStep !== null}
      />

      {/* 1. Expressive Vector Whiteboard Canvas & Draw-to-Focus Capture */}
      <DrawingCanvas
        externalDrawings={drawings}
        clearSignal={clearDrawingsSignal}
        onScribbleFocusCrop={(bbox) => {
          console.log("Captured focus crop bbox:", bbox);
          invokeCommand("analyze_screen_region", { bbox });
        }}
        onClearAll={handleClearDrawings}
      />

      {/* 2. Interactive Guided Walkthrough Target Box */}
      <GuidedStepBox
        step={walkthroughStep}
        currentStepIndex={walkthroughIndex}
        totalSteps={walkthroughTotal}
        onNext={handleNextStep}
        onPrev={handlePrevStep}
        onClose={() => setWalkthroughStep(null)}
      />

      {/* 3. Drive Mode Glowing Perimeter Border & Confirmation Modal */}
      <DriveBorder
        status={driveStatus}
        onConfirmAction={handleApproveDrive}
        onRejectAction={handleRejectDrive}
        onAbortDrive={handleAbortDrive}
      />

      {/* 4. Three.js 3D Interactive Spatial Object Viewer */}
      {model3D && model3D.visible && (
        <Model3DViewer model={model3D} onClose={() => setModel3D(null)} />
      )}

      {/* Developer Testing Bar (Toggle with Ctrl+Shift+O or hover bottom right) */}
      <div
        className="fixed bottom-3 right-3 z-50 pointer-events-auto"
        onMouseEnter={() => setIgnoreCursorEvents(false)}
        onMouseLeave={() => setIgnoreCursorEvents(true)}
      >
        {!showDevControls ? (
          <button
            onClick={() => setShowDevControls(true)}
            className="p-1.5 rounded-full bg-slate-900/80 border border-white/10 hover:border-sky-400 text-slate-400 hover:text-sky-300 shadow-xl backdrop-blur-md transition-all"
            title="Open Spatial Overlay Dev Sandbox (Ctrl+Shift+O)"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>
        ) : (
          <div className="flex items-center gap-1.5 p-2 rounded-2xl glass-panel border border-sky-400/40 shadow-2xl animate-float text-xs">
            <span className="text-[10px] font-bold text-sky-400 uppercase tracking-wider px-1">
              Dev Sandbox
            </span>

            {/* Test Point */}
            <button
              onClick={() => {
                const rx = Math.floor(Math.random() * 800) + 100;
                const ry = Math.floor(Math.random() * 600) + 100;
                setPoint({
                  x: Math.round((rx / window.innerWidth) * 1000),
                  y: Math.round((ry / window.innerHeight) * 1000),
                  label: "Target UI Element",
                  durationMs: 420,
                });
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-400/30"
            >
              <Navigation className="w-3 h-3" /> Point
            </button>

            {/* Test Draw Box */}
            <button
              onClick={() => {
                setDrawings((prev) => [
                  ...prev,
                  {
                    id: `dev-box-${Date.now()}`,
                    shape: "box",
                    coords: [350, 350, 650, 650],
                    label: "Critical Form Area",
                    color: "#10b981",
                    fadeMs: 8000,
                  },
                ]);
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-400/30"
            >
              <Edit3 className="w-3 h-3" /> Draw Box
            </button>

            {/* Test 3D Object */}
            <button
              onClick={() => {
                setModel3D({
                  id: "robot-gadget",
                  title: "Cybernetic Sensor Node",
                  geometryType: "robot",
                  visible: true,
                });
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-400/30"
            >
              <Box className="w-3 h-3" /> 3D View
            </button>

            {/* Toggle Cursor Follower */}
            <button
              onClick={() => setShowFollower(!showFollower)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg border transition-all ${
                showFollower
                  ? "bg-cyan-500/20 text-cyan-300 border-cyan-400/40"
                  : "bg-slate-800 text-slate-400 border-slate-700"
              }`}
            >
              <Sparkles className="w-3 h-3" /> Follower {showFollower ? "ON" : "OFF"}
            </button>

            {/* Test Guided Walkthrough */}
            <button
              onClick={() => {
                setWalkthroughStep({
                  step: 1,
                  instruction: "Click this primary button to deploy the fullstack project workspace.",
                  bbox: [220, 160, 480, 240],
                });
                setWalkthroughIndex(0);
                setWalkthroughTotal(3);
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-400/30"
            >
              <Eye className="w-3 h-3" /> Walkthrough
            </button>

            {/* Test Drive Warning */}
            <button
              onClick={() => {
                setDriveStatus({
                  state: "driving",
                  actionDescription: "Automating Chrome checkout flow...",
                  requiresConfirmation: true,
                  confirmationPayload: {
                    toolCallId: "tool-test-1",
                    toolName: "mouse_click",
                    description: "Simulate click at (450, 680) to confirm order payment.",
                    parameters: { x: 450, y: 680, button: "left" },
                    severity: "high",
                  },
                });
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-400/30"
            >
              <ShieldAlert className="w-3 h-3" /> Drive Gate
            </button>

            <button
              onClick={() => setShowDevControls(false)}
              className="text-slate-400 hover:text-white px-1.5 py-0.5"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
