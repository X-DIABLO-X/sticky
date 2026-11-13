import React from "react";
import type { WalkthroughStep } from "../../types/events";
import { ChevronRight, ChevronLeft, Check, Sparkles } from "lucide-react";
import { setIgnoreCursorEvents } from "../../lib/ipc";

interface GuidedStepBoxProps {
  step?: WalkthroughStep | null;
  currentStepIndex: number;
  totalSteps: number;
  onNext?: () => void;
  onPrev?: () => void;
  onClose?: () => void;
}

export const GuidedStepBox: React.FC<GuidedStepBoxProps> = ({
  step,
  currentStepIndex,
  totalSteps,
  onNext,
  onPrev,
  onClose,
}) => {
  if (!step || !step.bbox || step.bbox.length < 4) return null;

  const [x1, y1, x2, y2] = step.bbox;
  const width = Math.max(x2 - x1, 40);
  const height = Math.max(y2 - y1, 24);

  // Position tooltip above or below target depending on screen clearance
  const tooltipTop = y2 + 12 < window.innerHeight - 140 ? y2 + 12 : Math.max(16, y1 - 130);
  const tooltipLeft = Math.max(20, Math.min(x1, window.innerWidth - 380));

  return (
    <div className="fixed inset-0 pointer-events-none z-40 select-none">
      {/* Dimmed backdrop vignette highlighting the target cutout */}
      <div
        className="absolute inset-0 bg-slate-950/20 backdrop-blur-[0.5px] pointer-events-none transition-opacity duration-300"
        style={{
          clipPath: `polygon(
            0% 0%, 0% 100%, 100% 100%, 100% 0%,
            0% 0%,
            ${x1}px ${y1}px,
            ${x1 + width}px ${y1}px,
            ${x1 + width}px ${y1 + height}px,
            ${x1}px ${y1 + height}px,
            ${x1}px ${y1}px
          )`,
        }}
      />

      {/* Pulsing Highlight Target Box */}
      <div
        className="absolute rounded-lg border-2 border-sky-400 shadow-[0_0_25px_rgba(56,189,248,0.7)] pointer-events-none transition-all duration-300"
        style={{
          left: `${x1}px`,
          top: `${y1}px`,
          width: `${width}px`,
          height: `${height}px`,
        }}
      >
        {/* Pulsing outer aura */}
        <div className="absolute -inset-1 rounded-lg border border-sky-300/60 animate-ping opacity-40 pointer-events-none" />

        {/* Corner alignment brackets */}
        <div className="absolute -top-1.5 -left-1.5 w-3 h-3 border-t-2 border-l-2 border-white rounded-tl" />
        <div className="absolute -top-1.5 -right-1.5 w-3 h-3 border-t-2 border-r-2 border-white rounded-tr" />
        <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 border-b-2 border-l-2 border-white rounded-bl" />
        <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 border-b-2 border-r-2 border-white rounded-br" />
      </div>

      {/* Floating Instruction Card */}
      <div
        className="absolute w-84 p-4 rounded-xl glass-panel border border-sky-400/40 shadow-2xl pointer-events-auto transition-all duration-300"
        style={{
          left: `${tooltipLeft}px`,
          top: `${tooltipTop}px`,
        }}
        onMouseEnter={() => setIgnoreCursorEvents(false)}
        onMouseLeave={() => setIgnoreCursorEvents(true)}
      >
        {/* Badge & Step indicator */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sky-500/20 border border-sky-400/40 text-xs font-semibold text-sky-300">
            <Sparkles className="w-3 h-3 text-sky-400" />
            <span>
              Step {currentStepIndex + 1} of {totalSteps}
            </span>
          </div>

          <button
            onClick={onClose}
            className="text-xs text-slate-400 hover:text-white px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
          >
            Exit
          </button>
        </div>

        {/* Step Instruction Text */}
        <p className="text-sm font-medium text-slate-100 leading-snug mb-3">
          {step.instruction}
        </p>

        {/* Action Controls */}
        <div className="flex items-center justify-between pt-2 border-t border-white/10">
          <button
            onClick={onPrev}
            disabled={currentStepIndex === 0}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg text-slate-300 hover:bg-white/10 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Back</span>
          </button>

          <button
            onClick={onNext}
            className="flex items-center gap-1 px-3 py-1 text-xs font-semibold rounded-lg bg-sky-500 hover:bg-sky-400 text-white shadow-md shadow-sky-500/30 transition-all hover:scale-105"
          >
            {currentStepIndex + 1 === totalSteps ? (
              <>
                <Check className="w-3.5 h-3.5" />
                <span>Finish</span>
              </>
            ) : (
              <>
                <span>Next</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
