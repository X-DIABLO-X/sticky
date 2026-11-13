/**
 * Streaming Tag Parser for spatial commands emitted by the LLM
 * Detects and extracts [POINT:...], [DRAW:...], [3D:...], and [STEP:...]
 * and strips them from spoken text output so TTS doesn't read tags.
 */

import type { OverlayPointEvent, OverlayDrawEvent, Overlay3DEvent, WalkthroughStep } from "../types/events";

export interface TagParseCallbacks {
  onPoint?: (point: OverlayPointEvent) => void;
  onDraw?: (draw: OverlayDrawEvent) => void;
  on3D?: (model: Overlay3DEvent) => void;
  onStep?: (step: WalkthroughStep, current: number, total: number) => void;
  onCleanText?: (textChunk: string) => void;
}

export class StreamingTagParser {
  private buffer: string = "";
  private callbacks: TagParseCallbacks;

  constructor(callbacks: TagParseCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * Feed new streaming token chunk from LLM
   * Returns clean text for speech synthesis
   */
  public feed(chunk: string): string {
    this.buffer += chunk;
    let cleanOutput = "";

    while (this.buffer.length > 0) {
      const openBracketIdx = this.buffer.indexOf("[");

      if (openBracketIdx === -1) {
        // No tag opening found, emit entire buffer
        cleanOutput += this.buffer;
        this.buffer = "";
        break;
      }

      if (openBracketIdx > 0) {
        // Emit plain text preceding the tag
        cleanOutput += this.buffer.slice(0, openBracketIdx);
        this.buffer = this.buffer.slice(openBracketIdx);
      }

      // Check if closing bracket exists
      const closeBracketIdx = this.buffer.indexOf("]");
      if (closeBracketIdx === -1) {
        // Incomplete potential tag, wait for more chunks (unless buffer grows too large)
        if (this.buffer.length > 256) {
          cleanOutput += this.buffer[0];
          this.buffer = this.buffer.slice(1);
        }
        break;
      }

      // We have a complete bracketed candidate: [ ... ]
      const candidate = this.buffer.slice(0, closeBracketIdx + 1);
      const tagHandled = this.processTag(candidate);

      if (tagHandled) {
        // Advance past the tag without adding to clean text
        this.buffer = this.buffer.slice(closeBracketIdx + 1);
      } else {
        // Not a recognized tag; treat "[" as normal text and advance 1 char
        cleanOutput += this.buffer[0];
        this.buffer = this.buffer.slice(1);
      }
    }

    if (cleanOutput && this.callbacks.onCleanText) {
      this.callbacks.onCleanText(cleanOutput);
    }

    return cleanOutput;
  }

  /**
   * Flush any remaining buffered characters at stream end
   */
  public flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    if (remaining && this.callbacks.onCleanText) {
      this.callbacks.onCleanText(remaining);
    }
    return remaining;
  }

  private processTag(tagStr: string): boolean {
    // 1. [POINT:x,y:label:screenN] or [POINT:x,y:label]
    const pointMatch = tagStr.match(/^\[POINT:(\d+),(\d+):([^:\]]+)(?::([^\]]+))?\]$/i);
    if (pointMatch) {
      const x = parseInt(pointMatch[1], 10);
      const y = parseInt(pointMatch[2], 10);
      const label = pointMatch[3].trim();
      let screenIndex = 0;
      if (pointMatch[4]) {
        const screenStr = pointMatch[4].replace(/screen/i, "").trim();
        const parsed = parseInt(screenStr, 10);
        if (!isNaN(parsed)) screenIndex = parsed;
      }

      const pointEvent: OverlayPointEvent = { x, y, label, screenIndex };
      this.callbacks.onPoint?.(pointEvent);
      return true;
    }

    // 2. [DRAW:shape:coords:label:color]
    const drawMatch = tagStr.match(/^\[DRAW:([a-zA-Z]+):([0-9,\s]+)(?::([^:\]]*))?(?::([^\]]*))?\]$/i);
    if (drawMatch) {
      const shape = drawMatch[1].toLowerCase() as any;
      const coords = drawMatch[2]
        .split(",")
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => !isNaN(n));
      const label = drawMatch[3]?.trim() || undefined;
      const color = drawMatch[4]?.trim() || "#3186ff";

      const drawEvent: OverlayDrawEvent = { shape, coords, label, color, fadeMs: 8000 };
      this.callbacks.onDraw?.(drawEvent);
      return true;
    }

    // 3. [3D:id:title:type:x,y,w,h]
    const d3Match = tagStr.match(/^\[3D:([^:\]]+):([^:\]]+):([^:\]]+):([0-9,\s]+)\]$/i);
    if (d3Match) {
      const id = d3Match[1].trim();
      const title = d3Match[2].trim();
      const geometryType = d3Match[3].trim().toLowerCase() as any;
      const coords = d3Match[4]
        .split(",")
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => !isNaN(n));
      const bbox = coords.length === 4 ? (coords as [number, number, number, number]) : undefined;

      const d3Event: Overlay3DEvent = {
        id,
        title,
        geometryType,
        bbox,
        visible: true,
      };
      this.callbacks.on3D?.(d3Event);
      return true;
    }

    // 4. [STEP:current,total:instruction:x1,y1,x2,y2]
    const stepMatch = tagStr.match(/^\[STEP:(\d+),(\d+):([^:\]]+):([0-9,\s]+)\]$/i);
    if (stepMatch) {
      const current = parseInt(stepMatch[1], 10);
      const total = parseInt(stepMatch[2], 10);
      const instruction = stepMatch[3].trim();
      const coords = stepMatch[4]
        .split(",")
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => !isNaN(n));
      const bbox = coords.length === 4 ? (coords as [number, number, number, number]) : [100, 100, 300, 200];

      const step: WalkthroughStep = {
        step: current,
        instruction,
        bbox: bbox as [number, number, number, number],
      };
      this.callbacks.onStep?.(step, current, total);
      return true;
    }

    return false;
  }
}

/**
 * Utility to parse an entire text string at once
 */
export function parseCompleteText(fullText: string): {
  cleanText: string;
  points: OverlayPointEvent[];
  draws: OverlayDrawEvent[];
  models3d: Overlay3DEvent[];
  steps: WalkthroughStep[];
} {
  const points: OverlayPointEvent[] = [];
  const draws: OverlayDrawEvent[] = [];
  const models3d: Overlay3DEvent[] = [];
  const steps: WalkthroughStep[] = [];

  const parser = new StreamingTagParser({
    onPoint: (p) => points.push(p),
    onDraw: (d) => draws.push(d),
    on3D: (m) => models3d.push(m),
    onStep: (s) => steps.push(s),
  });

  const clean = parser.feed(fullText) + parser.flush();

  return {
    cleanText: clean,
    points,
    draws,
    models3d,
    steps,
  };
}
