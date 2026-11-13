import React, { useEffect, useState } from "react";
import type { DriveStatusEvent, DriveConfirmationPayload } from "../../types/events";
import { ShieldAlert, AlertTriangle, CheckCircle, XCircle, MousePointer, Shield } from "lucide-react";
import { setIgnoreCursorEvents } from "../../lib/ipc";

interface DriveBorderProps {
  status?: DriveStatusEvent | null;
  onConfirmAction?: (payload: DriveConfirmationPayload) => void;
  onRejectAction?: (payload: DriveConfirmationPayload) => void;
  onAbortDrive?: () => void;
}

export const DriveBorder: React.FC<DriveBorderProps> = ({
  status,
  onConfirmAction,
  onRejectAction,
  onAbortDrive,
}) => {
  const [mouseMovedFar, setMouseMovedFar] = useState(false);

  // Monitor mouse movements for emergency abort (>15px displacement watchdog)
  useEffect(() => {
    if (!status || status.state !== "driving") return;

    let initialPos: { x: number; y: number } | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      if (!initialPos) {
        initialPos = { x: e.clientX, y: e.clientY };
        return;
      }

      const dx = Math.abs(e.clientX - initialPos.x);
      const dy = Math.abs(e.clientY - initialPos.y);

      if (dx > 15 || dy > 15) {
        setMouseMovedFar(true);
        onAbortDrive?.();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onAbortDrive?.();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [status, onAbortDrive]);

  if (!status || status.state === "idle") return null;

  const isDriving = status.state === "driving";
  const hasConfirmation = status.requiresConfirmation && status.confirmationPayload;

  return (
    <>
      {/* Glowing Screen Perimeter Border */}
      {isDriving && (
        <div className="fixed inset-0 pointer-events-none z-40 border-[3px] border-amber-400/80 shadow-[inset_0_0_30px_rgba(245,158,11,0.35),0_0_20px_rgba(245,158,11,0.5)] animate-pulse">
          {/* Top-center status safety badge */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-slate-900/90 border border-amber-400/60 shadow-xl backdrop-blur-md text-xs font-semibold text-amber-200">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
            </span>
            <span className="tracking-wide">AI DRIVING DESKTOP</span>
            <span className="text-[11px] text-amber-300/80 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
              Move mouse &gt;15px or Esc to abort
            </span>
          </div>

          {/* Action progress description footer */}
          {status.actionDescription && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3.5 py-1 rounded-full bg-slate-900/80 border border-white/10 text-xs text-slate-300">
              <MousePointer className="w-3.5 h-3.5 text-amber-400 animate-spin" />
              <span>{status.actionDescription}</span>
            </div>
          )}
        </div>
      )}

      {/* Confirmation Modal Gate */}
      {hasConfirmation && status.confirmationPayload && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm pointer-events-auto select-none"
          onMouseEnter={() => setIgnoreCursorEvents(false)}
          onMouseLeave={() => setIgnoreCursorEvents(true)}
        >
          <div className="w-[480px] p-6 rounded-2xl glass-panel border border-amber-500/50 shadow-2xl animate-float">
            <div className="flex items-start gap-3 mb-4">
              <div className="p-2.5 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-400">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-white tracking-tight">
                    Confirm Desktop Action
                  </h3>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/30">
                    {status.confirmationPayload.toolName}
                  </span>
                </div>
                <p className="text-xs text-slate-300 mt-1">
                  {status.confirmationPayload.description}
                </p>
              </div>
            </div>

            {/* Action Parameters Inspector */}
            <div className="mb-4 p-3 rounded-lg bg-black/40 border border-white/10 text-xs font-mono text-slate-300 overflow-x-auto max-h-36">
              <div className="text-[10px] uppercase text-slate-400 font-sans font-semibold mb-1">
                Tool Parameters
              </div>
              <pre>{JSON.stringify(status.confirmationPayload.parameters, null, 2)}</pre>
            </div>

            {/* Security note */}
            <div className="flex items-center gap-2 text-xs text-amber-300/90 mb-5 bg-amber-500/10 p-2.5 rounded-lg border border-amber-500/20">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
              <span>
                Desktop simulation will execute real inputs. Ensure this action is expected.
              </span>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  onRejectAction?.(status.confirmationPayload!);
                  setIgnoreCursorEvents(true);
                }}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-white/10 hover:bg-white/20 text-slate-200 transition-colors"
              >
                <XCircle className="w-4 h-4 text-slate-400" />
                <span>Reject & Abort</span>
              </button>

              <button
                onClick={() => {
                  onConfirmAction?.(status.confirmationPayload!);
                  setIgnoreCursorEvents(true);
                }}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold shadow-lg shadow-amber-500/30 transition-transform hover:scale-105"
              >
                <CheckCircle className="w-4 h-4" />
                <span>Approve & Execute</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
