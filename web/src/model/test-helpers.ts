import type { Projector } from './snap';
import { v2, v3, type Vec2, type Vec3 } from './vec';

/** Deterministic pseudo-random numbers so stroke fixtures are reproducible. */
export function seededRandom(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function lineStroke(a: Vec2, b: Vec2, count = 40, jitter = 0, rand = seededRandom(7)): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push(v2(a.x + (b.x - a.x) * t + (rand() - 0.5) * jitter, a.y + (b.y - a.y) * t + (rand() - 0.5) * jitter));
  }
  return points;
}

export interface RectStrokeOptions {
  pointsPerSide?: number;
  jitter?: number;
  /** Where along the perimeter (0..1) the stroke starts. */
  startFraction?: number;
  clockwise?: boolean;
  /** Overshoot past each corner, as a fraction of the side. */
  overshoot?: number;
  /** Gap left between the end and the start, as a fraction of the perimeter. */
  gapFraction?: number;
  seed?: number;
}

export function rectStroke(x0: number, y0: number, w: number, h: number, options: RectStrokeOptions = {}): Vec2[] {
  const { pointsPerSide = 30, jitter = 0, startFraction = 0, clockwise = false, overshoot = 0, gapFraction = 0, seed = 3 } = options;
  const rand = seededRandom(seed);
  const corners = [v2(x0, y0), v2(x0 + w, y0), v2(x0 + w, y0 + h), v2(x0, y0 + h)];
  if (clockwise) corners.reverse();
  const perimeter: Vec2[] = [];
  for (let side = 0; side < 4; side++) {
    const a = corners[side];
    const b = corners[(side + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (let i = 0; i < pointsPerSide; i++) {
      const t = (i / pointsPerSide) * (1 + overshoot);
      perimeter.push(v2(a.x + dx * t + (rand() - 0.5) * jitter, a.y + dy * t + (rand() - 0.5) * jitter));
    }
  }
  const startIndex = Math.floor(startFraction * perimeter.length);
  const rotated = perimeter.slice(startIndex).concat(perimeter.slice(0, startIndex));
  const keep = Math.max(2, Math.round(rotated.length * (1 - gapFraction)));
  const stroke = rotated.slice(0, keep);
  if (gapFraction === 0) stroke.push(v2(stroke[0].x + (rand() - 0.5) * jitter, stroke[0].y + (rand() - 0.5) * jitter));
  return stroke;
}

export function rotatePoints(points: Vec2[], angleRad: number, center: Vec2): Vec2[] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return points.map((p) => {
    const x = p.x - center.x;
    const y = p.y - center.y;
    return v2(center.x + x * c - y * s, center.y + x * s + y * c);
  });
}

export function circleStroke(cx: number, cy: number, r: number, count = 80): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = (i / count) * Math.PI * 2;
    points.push(v2(cx + Math.cos(t) * r, cy + Math.sin(t) * r));
  }
  return points;
}

export function scribbleStroke(count = 120, seed = 11): Vec2[] {
  const rand = seededRandom(seed);
  const points: Vec2[] = [v2(0, 0)];
  for (let i = 1; i < count; i++) {
    const last = points[i - 1];
    points.push(v2(last.x + (rand() - 0.5) * 80, last.y + (rand() - 0.5) * 80));
  }
  return points;
}

/**
 * Orthographic top-view projector: screen x = ox + world.x * scale,
 * screen y = oy - world.y * scale; rays travel straight down -Z.
 */
export function topViewProjector(scale = 0.1, ox = 400, oy = 300): Projector {
  return {
    project: (world: Vec3) => v2(ox + world.x * scale, oy - world.y * scale),
    ray: (screen: Vec2) => ({ origin: v3((screen.x - ox) / scale, (oy - screen.y) / scale, 100000), dir: v3(0, 0, -1) }),
  };
}

/** Orthographic front-view projector: screen x = world.x, screen y = -world.z; rays travel +Y. */
export function frontViewProjector(scale = 0.1, ox = 400, oy = 300): Projector {
  return {
    project: (world: Vec3) => v2(ox + world.x * scale, oy - world.z * scale),
    ray: (screen: Vec2) => ({ origin: v3((screen.x - ox) / scale, -100000, (oy - screen.y) / scale), dir: v3(0, 1, 0) }),
  };
}
