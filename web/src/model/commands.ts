import {
  describeEntity,
  formatMm,
  lineLength,
  makeRect,
  rectFrame,
  type Entity,
  type Sketch,
} from './sketch';
import { add, distance, normalize, scale, sub, toArray, type Vec3 } from './vec';

export interface DimensionSpec {
  /** New length for a line, in mm. */
  length?: number;
  /** New width (along the origin corner's first edge) for a rectangle, in mm. */
  width?: number;
  /** New height (along the origin corner's second edge) for a rectangle, in mm. */
  height?: number;
}

export type CommandResult<T = Entity> =
  | { ok: true; entity: T; message: string }
  | { ok: false; error: string };

export interface ExportEntity {
  type: 'line' | 'rect';
  points: [number, number, number][];
}

export interface ExportPayload {
  units: 'mm';
  entities: ExportEntity[];
}

const UNIT_SCALE: Record<string, number> = { mm: 1, cm: 10, m: 1000 };

function parseNumber(text: string): number | null {
  const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*(mm|cm|m)?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  const unit = (match[2] ?? 'mm').toLowerCase();
  const scaled = value * UNIT_SCALE[unit];
  return Number.isFinite(scaled) ? scaled : null;
}

/**
 * Parse a measurement typed by the user (or spoken later).
 *
 * `"4000"` → `{ length: 4000 }`, `"4000x3000"` / `"4 m by 3 m"` → `{ width, height }`.
 */
export function parseDimensionSpec(text: string): DimensionSpec | null {
  const parts = text
    .trim()
    .split(/\s*(?:[x×*]|by)\s*/i)
    .filter(Boolean);
  if (parts.length === 1) {
    const length = parseNumber(parts[0]);
    return length !== null && length > 0 ? { length } : null;
  }
  if (parts.length === 2) {
    const width = parseNumber(parts[0]);
    const height = parseNumber(parts[1]);
    if (width === null || height === null || width <= 0 || height <= 0) return null;
    return { width, height };
  }
  return null;
}

/**
 * The single command surface for editing the sketch.  Keys, the measurement
 * input and future voice/AI integrations all call these methods, so the
 * behaviour (validation, undo labels, messages) stays identical.
 */
export class Commands {
  constructor(private readonly sketch: Sketch) {}

  addLine(a: Vec3, b: Vec3): CommandResult {
    if (distance(a, b) < 1e-6) return { ok: false, error: 'line has zero length' };
    const entity = this.sketch.addEntity({ type: 'line', a, b });
    return { ok: true, entity, message: `Added ${describeEntity(entity)}` };
  }

  addRect(corners: [Vec3, Vec3, Vec3, Vec3]): CommandResult {
    const width = distance(corners[0], corners[1]);
    const height = distance(corners[0], corners[3]);
    if (width < 1e-6 || height < 1e-6) return { ok: false, error: 'rectangle has a zero-length side' };
    const entity = this.sketch.addEntity({ type: 'rect', corners });
    return { ok: true, entity, message: `Added ${describeEntity(entity)}` };
  }

  deleteEntity(id: string): CommandResult {
    const entity = this.sketch.get(id);
    if (!entity) return { ok: false, error: 'nothing to delete' };
    this.sketch.removeEntity(id);
    return { ok: true, entity, message: `Deleted ${describeEntity(entity)}` };
  }

  deleteLast(): CommandResult {
    const entity = this.sketch.last;
    return entity ? this.deleteEntity(entity.id) : { ok: false, error: 'nothing to delete' };
  }

  setDimension(id: string, spec: DimensionSpec | string): CommandResult {
    const entity = this.sketch.get(id);
    if (!entity) return { ok: false, error: 'no entity selected' };
    const parsed = typeof spec === 'string' ? parseDimensionSpec(spec) : spec;
    if (!parsed) return { ok: false, error: `could not read "${spec}" (try 4000 or 4000x3000)` };

    if (entity.type === 'line') {
      if (parsed.length === undefined) return { ok: false, error: 'a line takes one length, e.g. 4000' };
      const current = lineLength(entity);
      if (current < 1e-9) return { ok: false, error: 'line has no direction' };
      const direction = normalize(sub(entity.b, entity.a));
      const next = this.sketch.replaceEntity(
        id,
        { type: 'line', a: entity.a, b: add(entity.a, scale(direction, parsed.length)) },
        `set length ${formatMm(parsed.length)}`,
      );
      return next
        ? { ok: true, entity: next, message: `Line length set to ${formatMm(parsed.length)}` }
        : { ok: false, error: 'entity vanished' };
    }

    if (parsed.width === undefined || parsed.height === undefined) {
      return { ok: false, error: 'a rectangle takes width x height, e.g. 4000x3000' };
    }
    const frame = rectFrame(entity);
    const next = this.sketch.replaceEntity(
      id,
      { type: 'rect', corners: makeRect(frame.origin, frame.uDir, frame.vDir, parsed.width, parsed.height) },
      `set size ${formatMm(parsed.width)} x ${formatMm(parsed.height)}`,
    );
    return next
      ? { ok: true, entity: next, message: `Rectangle set to ${formatMm(parsed.width)} x ${formatMm(parsed.height)}` }
      : { ok: false, error: 'entity vanished' };
  }

  undo(): string | null {
    return this.sketch.undo();
  }

  redo(): string | null {
    return this.sketch.redo();
  }

  clear(): number {
    return this.sketch.clear();
  }

  exportPayload(): ExportPayload {
    return {
      units: 'mm',
      entities: this.sketch.all.map((entity) => ({
        type: entity.type,
        points: (entity.type === 'line' ? [entity.a, entity.b] : entity.corners).map(toArray),
      })),
    };
  }
}
