/**
 * Cubic Bezier easing and humanized 2D cursor interpolation math
 * Powers 420ms smooth pointer transitions across the spatial overlay.
 */

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Solve cubic bezier curve x(t) = targetX using Newton-Raphson
 */
function sampleCurveX(t: number, p1x: number, p2x: number): number {
  return ((1 - 3 * p2x + 3 * p1x) * t + (3 * p2x - 6 * p1x)) * t * t + 3 * p1x * t;
}

function sampleCurveY(t: number, p1y: number, p2y: number): number {
  return ((1 - 3 * p2y + 3 * p1y) * t + (3 * p2y - 6 * p1y)) * t * t + 3 * p1y * t;
}

function sampleCurveDerivativeX(t: number, p1x: number, p2x: number): number {
  return (3 * (1 - 3 * p2x + 3 * p1x) * t + 2 * (3 * p2x - 6 * p1x)) * t + 3 * p1x;
}

/**
 * Standard cubic bezier easing calculator (default: ease-out / snappy smooth [0.22, 1, 0.36, 1])
 */
export function cubicBezierEasing(
  x: number,
  p1x: number = 0.22,
  p1y: number = 1.0,
  p2x: number = 0.36,
  p2y: number = 1.0
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Newton-Raphson iteration
  let t = x;
  for (let i = 0; i < 8; i++) {
    const currentX = sampleCurveX(t, p1x, p2x) - x;
    if (Math.abs(currentX) < 1e-6) break;
    const dX = sampleCurveDerivativeX(t, p1x, p2x);
    if (Math.abs(dX) < 1e-6) break;
    t -= currentX / dX;
  }

  return sampleCurveY(t, p1y, p2y);
}

/**
 * Interpolates between two points with humanized slight arc curve
 */
export function interpolate2D(
  start: Point2D,
  end: Point2D,
  progress: number,
  arcStrength: number = 0.08
): Point2D {
  const eased = cubicBezierEasing(progress);

  // Linear progression
  const basePointX = start.x + (end.x - start.x) * eased;
  const basePointY = start.y + (end.y - start.y) * eased;

  // Natural human curve: parabolic bell deviation perpendicular to direction
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 10) {
    return { x: basePointX, y: basePointY };
  }

  // Bell curve peaking at t = 0.5: 4 * t * (1 - t)
  const bell = 4 * eased * (1 - eased);
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const offset = bell * dist * arcStrength;

  return {
    x: basePointX + perpX * offset,
    y: basePointY + perpY * offset,
  };
}

/**
 * Runs a 420ms smooth cursor animation frame loop
 * Returns a cancel function.
 */
export function animatePointerTransition(
  start: Point2D,
  end: Point2D,
  durationMs: number = 420,
  onUpdate: (point: Point2D, progress: number) => void,
  onComplete?: () => void
): () => void {
  let animId: number;
  const startTime = performance.now();
  let cancelled = false;

  const step = (now: number) => {
    if (cancelled) return;

    const elapsed = now - startTime;
    const progress = Math.min(elapsed / durationMs, 1.0);

    const currentPos = interpolate2D(start, end, progress);
    onUpdate(currentPos, progress);

    if (progress < 1.0) {
      animId = requestAnimationFrame(step);
    } else {
      onComplete?.();
    }
  };

  animId = requestAnimationFrame(step);

  return () => {
    cancelled = true;
    cancelAnimationFrame(animId);
  };
}
