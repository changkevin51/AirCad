import type { PlaneKind } from './plane';
import { applyInPlaneAngle } from './spatial-plane-fit';
import {
  describeEntity,
  formatMm,
  extrusionOffset,
  isExtrudableProfile,
  lineLength,
  makeRect,
  rectFrame,
  type Entity,
  type EntityInput,
  type Sketch,
  type SolidEntity,
} from './sketch';
import { add, distance, isFinite3, nearlyEqual, normalize, scale, sub, toArray, type Vec3 } from './vec';

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

export type BatchCommandResult =
  | { ok: true; entities: Entity[]; message: string }
  | { ok: false; error: string };

export type ExportEntity =
  | { type: 'line' | 'rect' | 'extrusion'; points: [number, number, number][]; vector?: [number, number, number] };

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

/** Signed distance for extrusion, with the same mm/cm/m units as measurements. */
export function parseDepth(text: string): number | null {
  const value = parseNumber(text);
  return value !== null && Math.abs(value) >= 1e-6 ? value : null;
}

/**
 * Parse a measurement typed by the user (or spoken later).
 *
 * `"4000"` → `{ length: 4000 }`, `"4000x3000"` / `"4 m by 3 m"` → `{ width, height }`.
 */
/** Parse a typed in-plane angle: `45`, `45°`, `45 deg`. */
export function parseAngleDeg(text: string): number | null {
  const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*(?:°|deg(?:rees?)?)?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

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

  commitStroke(input: EntityInput, replaceIds: readonly string[] = []): CommandResult {
    if (replaceIds.length === 0) {
      if (input.type === 'line') return this.addLine(input.a, input.b);
      if (input.type === 'rect') return this.addRect(input.corners);
      return { ok: false, error: 'stroke completion expects a line or rectangle' };
    }
    if (input.type !== 'rect') return { ok: false, error: 'stroke completion expects a rectangle' };
    if (!input.corners.every(isFinite3)) return { ok: false, error: 'entity coordinates must be finite' };
    const width = distance(input.corners[0], input.corners[1]);
    const height = distance(input.corners[0], input.corners[3]);
    if (width < 1e-6 || height < 1e-6) return { ok: false, error: 'rectangle has a zero-length side' };
    for (const id of replaceIds) {
      if (!this.sketch.get(id)) return { ok: false, error: 'shared geometry changed; draw again' };
    }
    const [entity] = this.sketch.replaceEntities(replaceIds, [input], 'complete rectangle');
    return { ok: true, entity, message: `Completed ${describeEntity(entity)}` };
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

  setLineAngle(id: string, spec: string | number, kind: PlaneKind): CommandResult {
    const entity = this.sketch.get(id);
    if (!entity) return { ok: false, error: 'no entity selected' };
    if (entity.type !== 'line') return { ok: false, error: 'angle applies to a line' };
    const deg = typeof spec === 'number' ? spec : parseAngleDeg(spec);
    if (deg === null || !Number.isFinite(deg)) return { ok: false, error: `could not read angle "${spec}" (try 45 or 45°)` };
    const nextB = applyInPlaneAngle(entity.a, entity.b, kind, deg);
    if (nearlyEqual(nextB, entity.b, 1e-6)) {
      return { ok: true, entity, message: `Line angle already ${deg}°` };
    }
    const next = this.sketch.replaceEntity(id, { type: 'line', a: entity.a, b: nextB }, `set angle ${deg}°`);
    return next
      ? { ok: true, entity: next, message: `Line angle set to ${deg}°` }
      : { ok: false, error: 'entity vanished' };
  }

  extrude(id: string, depth: number, geometry?: [Vec3, Vec3, Vec3, Vec3]): CommandResult {
    const result = this.prepareExtrusion(id, depth, geometry);
    if (!result.ok || result.entity === this.sketch.get(id)) return result;
    const label = `extrude ${formatMm(depth)}`;
    const next = this.sketch.replaceEntity(id, result.entity, label);
    return next ? { ...result, entity: next } : { ok: false, error: 'entity vanished' };
  }

  extrudeMany(previews: readonly SolidEntity[]): BatchCommandResult {
    const ids = new Set<string>();
    const changed: SolidEntity[] = [];
    for (const preview of previews) {
      if (ids.has(preview.id)) return { ok: false, error: 'A shape can only appear once in an extrusion operation' };
      ids.add(preview.id);
      const geometry = preview.corners;
      const result = this.prepareExtrusion(preview.id, preview.depth, geometry);
      if (!result.ok) return result;
      if (result.entity !== this.sketch.get(preview.id)) changed.push(result.entity);
    }
    if (!changed.length) return { ok: true, entities: [], message: 'No extrusion changes' };
    const first = changed[0];
    const label = changed.length === 1
      ? `extrude ${formatMm(first.depth)}`
      : `extrude ${changed.length} shapes`;
    const entities = this.sketch.replaceEntities(changed, label);
    return entities
      ? { ok: true, entities, message: `Applied extrusion to ${entities.length} ${entities.length === 1 ? 'shape' : 'shapes'}` }
      : { ok: false, error: 'An extrusion target is no longer available' };
  }

  private prepareExtrusion(id: string, depth: number, geometry?: [Vec3, Vec3, Vec3, Vec3]): CommandResult<SolidEntity> {
    const entity = this.sketch.get(id);
    if (!entity) return { ok: false, error: 'Select a closed rectangle to extrude' };
    if (entity.type === 'line') return { ok: false, error: 'A line cannot be extruded. Draw a closed rectangle first.' };
    if (!Number.isFinite(depth) || Math.abs(depth) < 1e-6) return { ok: false, error: 'Extrusion depth must be a non-zero distance' };

    const corners = geometry;
    const base = corners ?? entity.corners;
    if (!isExtrudableProfile(base)) return { ok: false, error: 'Extrusion needs a planar rectangle with non-zero sides' };
    const unchanged =
      entity.type === 'extrusion' &&
      entity.depth === depth &&
      entity.corners.every((corner, index) => nearlyEqual(corner, base[index], 1e-6));
    if (unchanged) return { ok: true, entity, message: 'Extrusion depth unchanged' };
    return { ok: true, entity: { id, type: 'extrusion', corners: base, depth }, message: `Extruded to ${formatMm(depth)}` };
  }

  setDimension(id: string, spec: DimensionSpec | string): CommandResult {
    const entity = this.sketch.get(id);
    if (!entity) return { ok: false, error: 'no entity selected' };
    if (entity.type === 'extrusion' && typeof spec === 'string') {
      const depth = parseDepth(spec);
      if (depth !== null) return this.extrude(id, depth);
    }
    const parsed = typeof spec === 'string' ? parseDimensionSpec(spec) : spec;
    if (!parsed) return { ok: false, error: `could not read "${spec}" (try 4000 or 4000x3000)` };
    if (Object.values(parsed).some((value) => !Number.isFinite(value) || value <= 0)) return { ok: false, error: 'Dimensions must be positive finite distances' };
    if (entity.type === 'extrusion' && parsed.length !== undefined) return this.extrude(id, parsed.length);

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
      { ...entity, corners: makeRect(frame.origin, frame.uDir, frame.vDir, parsed.width, parsed.height) },
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
      entities: this.sketch.all.map((entity): ExportEntity => ({
        type: entity.type,
        points: (entity.type === 'line' ? [entity.a, entity.b] : entity.corners).map(toArray),
        ...(entity.type === 'extrusion' ? { vector: toArray(extrusionOffset(entity)) } : {}),
      })),
    };
  }
}
