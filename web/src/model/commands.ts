import {
  describeEntity,
  formatMm,
  extrusionOffset,
  isExtrudableProfile,
  isRectangleProfile,
  lineLength,
  makeRect,
  rectFrame,
  type Entity,
  type LineLoopProfile,
  type Sketch,
} from './sketch';
import { polygonFrame } from './polygon';
import { add, distance, nearlyEqual, normalize, scale, sub, toArray, type Vec3 } from './vec';

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

export type ExportEntity =
  | { type: 'line' | 'rect' | 'extrusion' | 'polygon'; points: [number, number, number][]; vector?: [number, number, number] }
  | { type: 'circle'; center: [number, number, number]; normal: [number, number, number]; radius: number };

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

  addPolygon(corners: Vec3[]): CommandResult {
    if (!polygonFrame(corners)) return { ok: false, error: 'A closed outline needs at least three corners forming a simple planar loop' };
    const entity = this.sketch.addEntity({ type: 'polygon', corners });
    return { ok: true, entity, message: `Added ${describeEntity(entity)}` };
  }

  private unsharedSourceIds(loop: LineLoopProfile): string[] {
    const shared = new Set(
      this.sketch.closedLineProfiles
        .filter((other) => other.id !== loop.id)
        .flatMap((other) => other.sourceIds),
    );
    return loop.sourceIds.filter((id) => !shared.has(id));
  }

  deleteEntity(id: string): CommandResult {
    const entity = this.sketch.get(id);
    if (entity) {
      this.sketch.removeEntity(id);
      return { ok: true, entity, message: `Deleted ${describeEntity(entity)}` };
    }
    const loop = this.sketch.closedLineProfiles.find((profile) => profile.id === id);
    if (!loop) return { ok: false, error: 'nothing to delete' };
    const sourceIds = this.unsharedSourceIds(loop);
    if (!sourceIds.length) return { ok: false, error: 'This outline shares all its edges; select an individual boundary line to delete it' };
    this.sketch.replaceEntities(sourceIds, null, `delete ${describeEntity(loop)}`);
    return { ok: true, entity: loop, message: `Deleted ${describeEntity(loop)}` };
  }

  deleteLast(): CommandResult {
    const entity = this.sketch.last;
    return entity ? this.deleteEntity(entity.id) : { ok: false, error: 'nothing to delete' };
  }

  extrude(id: string, depth: number, corners?: Vec3[]): CommandResult {
    const profile = this.sketch.getProfile(id);
    if (!profile) {
      const entity = this.sketch.get(id);
      if (entity?.type === 'line') return { ok: false, error: 'A line cannot be extruded. Draw a closed planar outline first.' };
      if (entity?.type === 'circle') return { ok: false, error: 'A circle cannot be extruded. Draw a closed planar outline instead.' };
      return { ok: false, error: 'Select a closed planar outline to extrude' };
    }
    if (!Number.isFinite(depth) || Math.abs(depth) < 1e-6) return { ok: false, error: 'Extrusion depth must be a non-zero distance' };
    const base = corners ?? profile.corners;
    if (!isExtrudableProfile(base)) return { ok: false, error: 'Extrusion needs a simple closed planar outline' };
    const unchanged =
      profile.type === 'extrusion' &&
      profile.depth === depth &&
      profile.corners.length === base.length &&
      profile.corners.every((corner, index) => nearlyEqual(corner, base[index], 1e-6));
    if (unchanged) return { ok: true, entity: profile, message: 'Extrusion depth unchanged' };
    const label = `extrude ${formatMm(depth)}`;
    if (this.sketch.get(profile.id)) {
      const next = this.sketch.replaceEntity(profile.id, { type: 'extrusion', corners: base, depth }, label);
      return next ? { ok: true, entity: next, message: `Extruded to ${formatMm(depth)}` } : { ok: false, error: 'entity vanished' };
    }
    const loop = profile as LineLoopProfile;
    const removed = loop.sourceIds ? this.unsharedSourceIds(loop) : [];
    const next = this.sketch.replaceEntities(removed, { type: 'extrusion', corners: base, depth }, label);
    return next ? { ok: true, entity: next, message: `Extruded to ${formatMm(depth)}` } : { ok: false, error: 'entity vanished' };
  }

  setDimension(id: string, spec: DimensionSpec | string): CommandResult {
    const entity = this.sketch.get(id);
    const profile = entity && entity.type !== 'line' && entity.type !== 'circle'
      ? entity
      : entity ? null : this.sketch.getProfile(id);
    if (!entity && !profile) return { ok: false, error: 'no entity selected' };
    if (entity?.type === 'circle') return { ok: false, error: 'Circle size is read-only; redraw it as a closed outline to edit' };

    if (profile) {
      if ((profile.type === 'extrusion' || profile.type === 'polygon') && typeof spec === 'string') {
        const depth = parseDepth(spec);
        if (depth !== null) return this.extrude(profile.id, depth);
      }
      const parsed = typeof spec === 'string' ? parseDimensionSpec(spec) : spec;
      if (!parsed) return { ok: false, error: `could not read "${spec}" (try 4000 or 4000x3000)` };
      if (Object.values(parsed).some((value) => !Number.isFinite(value) || value <= 0)) return { ok: false, error: 'Dimensions must be positive finite distances' };
      if (parsed.length !== undefined && profile.type !== 'rect') return this.extrude(profile.id, parsed.length);
      if (profile.type === 'polygon' || !isRectangleProfile(profile.corners)) {
        return { ok: false, error: 'a closed outline or non-rectangular solid takes one depth, e.g. 4000 or -250' };
      }
      if (parsed.width === undefined || parsed.height === undefined) {
        return { ok: false, error: 'a rectangle takes width x height, e.g. 4000x3000' };
      }
      const frame = rectFrame(profile);
      const input = profile.type === 'extrusion'
        ? { type: 'extrusion' as const, corners: makeRect(frame.origin, frame.uDir, frame.vDir, parsed.width, parsed.height), depth: profile.depth }
        : { type: 'rect' as const, corners: makeRect(frame.origin, frame.uDir, frame.vDir, parsed.width, parsed.height) };
      const next = this.sketch.replaceEntity(profile.id, input, `set size ${formatMm(parsed.width)} x ${formatMm(parsed.height)}`);
      return next
        ? { ok: true, entity: next, message: `Rectangle set to ${formatMm(parsed.width)} x ${formatMm(parsed.height)}` }
        : { ok: false, error: 'entity vanished' };
    }

    if (entity?.type === 'line') {
      const parsed = typeof spec === 'string' ? parseDimensionSpec(spec) : spec;
      if (!parsed) return { ok: false, error: `could not read "${spec}" (try 4000 or 4000x3000)` };
      if (Object.values(parsed).some((value) => !Number.isFinite(value) || value <= 0)) return { ok: false, error: 'Dimensions must be positive finite distances' };
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
    return { ok: false, error: 'no entity selected' };
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
      entities: this.sketch.all.map((entity): ExportEntity => entity.type === 'circle'
        ? { type: 'circle', center: toArray(entity.center), normal: toArray(entity.normal), radius: entity.radius }
        : {
            type: entity.type,
            points: (entity.type === 'line' ? [entity.a, entity.b] : entity.corners).map(toArray),
            ...(entity.type === 'extrusion' ? { vector: toArray(extrusionOffset(entity)) } : {}),
          }),
    };
  }
}
