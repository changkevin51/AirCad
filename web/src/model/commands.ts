import type { PlaneKind } from './plane';
import { polygonFrame } from './polygon';
import { applyInPlaneAngle } from './spatial-plane-fit';
import {
  describeEntity,
  formatMm,
  entityPoints,
  extrusionOffset,
  isExtrudableProfile,
  isRectangleProfile,
  isTriangleProfile,
  lineLength,
  makeRect,
  rectFrame,
  scaleEntity,
  translateEntity,
  type Entity,
  type PrismEntity,
  type EntityInput,
  type LineLoopProfile,
  type Sketch,
  type SolidEntity,
  type TriangleEntity,
} from './sketch';
import { add, distance, isFinite3, nearlyEqual, normalize, scale, sub, toArray, v3, type Vec3 } from './vec';

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
  | { type: 'line' | 'rect' | 'extrusion' | 'polygon' | 'triangle' | 'prism'; points: [number, number, number][]; vector?: [number, number, number] }
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

  addPolygon(corners: Vec3[]): CommandResult {
    if (!polygonFrame(corners)) return { ok: false, error: 'A closed outline needs at least three corners forming a simple planar loop' };
    const entity = this.sketch.addEntity({ type: 'polygon', corners });
    return { ok: true, entity, message: `Added ${describeEntity(entity)}` };
  }

  addTriangle(corners: TriangleEntity['corners']): CommandResult {
    if (!isTriangleProfile(corners)) return { ok: false, error: 'A triangle needs three finite, non-collinear corners' };
    const entity = this.sketch.addEntity({ type: 'triangle', corners });
    return { ok: true, entity, message: `Added ${describeEntity(entity)}` };
  }

  commitStroke(input: EntityInput, replaceIds: readonly string[] = []): CommandResult {
    if (replaceIds.length === 0) {
      if (input.type === 'line') return this.addLine(input.a, input.b);
      if (input.type === 'rect') return this.addRect(input.corners);
      if (input.type === 'polygon') return this.addPolygon(input.corners);
      if (input.type === 'triangle') return this.addTriangle(input.corners);
      return { ok: false, error: 'stroke completion expects a line, rectangle, triangle, or closed outline' };
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

  move(id: string, offset: Vec3): CommandResult {
    const entity = this.sketch.get(id);
    if (!entity) return { ok: false, error: 'Select a shape to move' };
    if (!isFinite3(offset)) return { ok: false, error: 'Move distances must be finite' };
    if (nearlyEqual(offset, v3(0, 0, 0), 1e-6)) return { ok: true, entity, message: 'Position unchanged' };
    const moved = translateEntity(entity, offset);
    if (!entityPoints(moved).every(isFinite3)
      || ((moved.type === 'extrusion' || moved.type === 'polygon') && !isExtrudableProfile(moved.corners))
      || ((moved.type === 'triangle' || moved.type === 'prism') && !isTriangleProfile(moved.corners))) {
      return { ok: false, error: 'Move is outside the supported coordinate range' };
    }
    const next = this.sketch.replaceEntity(id, moved, `move ${entity.type}`);
    return next ? { ok: true, entity: next, message: `Moved ${describeEntity(next)}` } : { ok: false, error: 'entity vanished' };
  }

  scale(id: string, anchor: Vec3, factor: number): CommandResult {
    const entity = this.sketch.get(id);
    if (!entity) return { ok: false, error: 'Select a shape to scale' };
    if (!isFinite3(anchor) || !Number.isFinite(factor) || factor <= 0) return { ok: false, error: 'Scaling needs a finite anchor and a positive finite factor' };
    if (factor === 1) return { ok: true, entity, message: 'Size unchanged' };
    const scaled = scaleEntity(entity, anchor, factor);
    if (!scaled) return { ok: false, error: 'Scale would collapse the shape or exceed the supported coordinate range' };
    const next = this.sketch.replaceEntity(id, scaled, `scale ${entity.type}`);
    return next ? { ok: true, entity: next, message: `Scaled ${describeEntity(next)}` } : { ok: false, error: 'entity vanished' };
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
    if (profile.type === 'triangle' || profile.type === 'prism') {
      if (corners && !isTriangleProfile(corners)) return { ok: false, error: 'A triangle extrusion needs three finite, non-collinear corners' };
      const base = (corners ?? profile.corners) as TriangleEntity['corners'];
      if (!isTriangleProfile(base)) return { ok: false, error: 'Extrusion needs three finite, non-collinear corners' };
      const preview: PrismEntity = { id: profile.id, type: 'prism', corners: base, depth };
      if (!entityPoints(preview).every(isFinite3)) return { ok: false, error: 'Extrusion is outside the supported coordinate range' };
      const unchanged = profile.type === 'prism' && profile.depth === depth
        && profile.corners.every((corner, index) => nearlyEqual(corner, base[index], 1e-6));
      if (unchanged) return { ok: true, entity: profile, message: 'Prism depth unchanged' };
      const next = this.sketch.replaceEntity(profile.id, preview, `extrude prism ${formatMm(depth)}`);
      return next ? { ok: true, entity: next, message: `Extruded triangle to ${formatMm(depth)}` } : { ok: false, error: 'entity vanished' };
    }
    if (corners) {
      if (profile.type === 'rect' && !isRectangleProfile(corners)) {
        return { ok: false, error: 'Extrusion needs a simple closed planar outline' };
      }
      if (!isExtrudableProfile(corners)) return { ok: false, error: 'Extrusion needs a simple closed planar outline' };
    }
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

  extrudeMany(previews: readonly SolidEntity[]): BatchCommandResult {
    const ids = new Set<string>();
    const changed: Array<(Extract<EntityInput, { type: 'extrusion' | 'prism' }>) & { id: string }> = [];
    for (const preview of previews) {
      if (ids.has(preview.id)) return { ok: false, error: 'A shape can only appear once in an extrusion operation' };
      ids.add(preview.id);
      const existing = this.sketch.get(preview.id);
      if (!existing || existing.type === 'line' || existing.type === 'circle') {
        return { ok: false, error: 'Select a closed planar outline to extrude' };
      }
      if (!Number.isFinite(preview.depth) || Math.abs(preview.depth) < 1e-6) {
        return { ok: false, error: 'Extrusion depth must be a non-zero distance' };
      }
      if (preview.type === 'prism') {
        if (!isTriangleProfile(preview.corners)) return { ok: false, error: 'Extrusion needs three finite, non-collinear corners' };
        const unchanged = existing.type === 'prism'
          && existing.depth === preview.depth
          && existing.corners.every((corner, index) => nearlyEqual(corner, preview.corners[index], 1e-6));
        if (!unchanged) changed.push({ id: preview.id, type: 'prism', corners: preview.corners, depth: preview.depth });
        continue;
      }
      if (!isExtrudableProfile(preview.corners)) {
        return { ok: false, error: 'Extrusion needs a simple closed planar outline' };
      }
      const unchanged =
        existing.type === 'extrusion' &&
        existing.depth === preview.depth &&
        existing.corners.length === preview.corners.length &&
        existing.corners.every((corner, index) => nearlyEqual(corner, preview.corners[index], 1e-6));
      if (!unchanged) {
        changed.push({ id: preview.id, type: 'extrusion', corners: preview.corners, depth: preview.depth });
      }
    }
    if (!changed.length) return { ok: true, entities: [], message: 'No extrusion changes' };
    const first = changed[0];
    const label = changed.length === 1
      ? `extrude ${first.type === 'prism' ? 'prism ' : ''}${formatMm(first.depth)}`
      : `extrude ${changed.length} shapes`;
    const entities = this.sketch.replaceEntities(changed, label);
    return entities
      ? { ok: true, entities, message: `Applied extrusion to ${entities.length} ${entities.length === 1 ? 'shape' : 'shapes'}` }
      : { ok: false, error: 'An extrusion target is no longer available' };
  }

  setDimension(id: string, spec: DimensionSpec | string): CommandResult {
    const entity = this.sketch.get(id);
    const profile = entity && entity.type !== 'line' && entity.type !== 'circle'
      ? entity
      : entity ? null : this.sketch.getProfile(id);
    if (!entity && !profile) return { ok: false, error: 'no entity selected' };
    if (entity?.type === 'circle') return { ok: false, error: 'Circle size is read-only; redraw it as a closed outline to edit' };
    if (entity?.type === 'triangle') return { ok: false, error: 'Use Q to extrude the triangle or M to move it' };

    if (profile) {
      if ((profile.type === 'extrusion' || profile.type === 'polygon' || profile.type === 'prism') && typeof spec === 'string') {
        const depth = parseDepth(spec);
        if (depth !== null) return this.extrude(profile.id, depth);
      }
      const parsed = typeof spec === 'string' ? parseDimensionSpec(spec) : spec;
      if (!parsed) return { ok: false, error: `could not read "${spec}" (try 4000 or 4000x3000)` };
      if (Object.values(parsed).some((value) => !Number.isFinite(value) || value <= 0)) return { ok: false, error: 'Dimensions must be positive finite distances' };
      if (parsed.length !== undefined && profile.type !== 'rect') return this.extrude(profile.id, parsed.length);
      if (profile.type === 'polygon' || profile.type === 'prism' || !isRectangleProfile(profile.corners)) {
        return { ok: false, error: profile.type === 'prism'
          ? 'a triangular prism takes one depth, e.g. 100 or 10 cm'
          : 'a closed outline or non-rectangular solid takes one depth, e.g. 4000 or -250' };
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

  exportPayload(entities: readonly Entity[] = this.sketch.all): ExportPayload {
    return {
      units: 'mm',
      entities: entities.map((entity): ExportEntity => {
        if (entity.type === 'circle') {
          return { type: 'circle', center: toArray(entity.center), normal: toArray(entity.normal), radius: entity.radius };
        }
        const points = (entity.type === 'line' ? [entity.a, entity.b] : entity.corners).map(toArray);
        return entity.type === 'extrusion' || entity.type === 'prism'
          ? { type: entity.type, points, vector: toArray(extrusionOffset(entity)) }
          : { type: entity.type, points };
      }),
    };
  }
}
