import {
  add,
  clone,
  cross,
  distance,
  dot,
  isFinite3,
  length,
  lerp,
  normalize,
  scale,
  sub,
  v3,
  type Vec3,
} from './vec';

export interface LineEntity {
  id: string;
  type: 'line';
  a: Vec3;
  b: Vec3;
}

/** Planar rectangle; corners are ordered around the outline, `corners[0]` is the origin corner. */
export interface RectEntity {
  id: string;
  type: 'rect';
  corners: [Vec3, Vec3, Vec3, Vec3];
}

/** A closed rectangular profile swept along its positive plane normal by a signed depth in mm. */
export interface ExtrusionEntity {
  id: string;
  type: 'extrusion';
  corners: RectEntity['corners'];
  depth: number;
}

/** A closed circular profile swept along its stored unit normal by a signed depth in mm. */
export interface CylinderEntity {
  id: string;
  type: 'cylinder';
  /** Centre of the base circle. The far cap is `center + normal * depth`. */
  center: Vec3;
  /** Unit axis. A negative depth still uses this same stored axis. */
  normal: Vec3;
  radius: number;
  depth: number;
}

export interface CircleEntity {
  id: string;
  type: 'circle';
  center: Vec3;
  normal: Vec3;
  radius: number;
}

export type CircleGeometry = Pick<CircleEntity, 'center' | 'normal' | 'radius'>;

export type RectProfileEntity = RectEntity | ExtrusionEntity;
export type SolidEntity = ExtrusionEntity | CylinderEntity;
export type ProfileEntity = RectProfileEntity | CircleEntity | CylinderEntity;
export type Entity = LineEntity | ProfileEntity | CircleEntity;
export type EntityInput =
  | { type: 'line'; a: Vec3; b: Vec3 }
  | { type: 'rect'; corners: RectEntity['corners'] }
  | { type: 'extrusion'; corners: RectEntity['corners']; depth: number }
  | { type: 'circle'; center: Vec3; normal: Vec3; radius: number }
  | { type: 'cylinder'; center: Vec3; normal: Vec3; radius: number; depth: number };

export interface Vertex {
  entityId: string;
  point: Vec3;
  /** Index of the vertex within its entity. */
  index: number;
}

export interface Segment {
  entityId: string;
  a: Vec3;
  b: Vec3;
  index: number;
  /** Analytic circle supporting this segment, used to project ring snaps exactly. */
  circle?: CircleGeometry;
}

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

export interface SketchJSON {
  version: 1;
  units: 'mm';
  entities: Entity[];
}

export interface SketchCommand {
  label: string;
  apply(): void;
  revert(): void;
}

export type SketchListener = (reason: string) => void;

export const lineLength = (line: LineEntity): number => distance(line.a, line.b);

export function rectFrame(rect: RectProfileEntity): { origin: Vec3; uDir: Vec3; vDir: Vec3; width: number; height: number } {
  const [c0, c1, , c3] = rect.corners;
  const uEdge = sub(c1, c0);
  const vEdge = sub(c3, c0);
  return {
    origin: clone(c0),
    uDir: normalize(uEdge),
    vDir: normalize(vEdge),
    width: distance(c0, c1),
    height: distance(c0, c3),
  };
}

export function makeRect(origin: Vec3, uDir: Vec3, vDir: Vec3, width: number, height: number): [Vec3, Vec3, Vec3, Vec3] {
  const u = scale(normalize(uDir), width);
  const v = scale(normalize(vDir), height);
  return [clone(origin), add(origin, u), add(add(origin, u), v), add(origin, v)];
}

export function rectNormal(rect: RectProfileEntity): Vec3 {
  const { uDir, vDir } = rectFrame(rect);
  return normalize(v3(
    uDir.y * vDir.z - uDir.z * vDir.y,
    uDir.z * vDir.x - uDir.x * vDir.z,
    uDir.x * vDir.y - uDir.y * vDir.x,
  ));
}

/** A positive dominant axis makes depth independent of the direction the rectangle was drawn. */
export function extrusionNormal(profile: RectProfileEntity): Vec3 {
  const normal = rectNormal(profile);
  const dominant = [normal.x, normal.y, normal.z].reduce((a, b) => Math.abs(a) >= Math.abs(b) ? a : b);
  return dominant < 0 ? scale(normal, -1) : normal;
}

export const extrusionOffset = (entity: ExtrusionEntity): Vec3 => scale(extrusionNormal(entity), entity.depth);

/** The signed axial offset for a cylinder. */
export const cylinderOffset = (entity: Pick<CylinderEntity, 'normal' | 'depth'>): Vec3 =>
  scale(normalize(entity.normal), entity.depth);

export const cylinderTopCenter = (entity: Pick<CylinderEntity, 'center' | 'normal' | 'depth'>): Vec3 =>
  add(entity.center, cylinderOffset(entity));

function circleExtremaPoints(circle: CircleGeometry): Vec3[] {
  const normal = normalize(circle.normal);
  return (['x', 'y', 'z'] as const).flatMap((axis) => {
    const axisVector = axis === 'x' ? v3(1, 0, 0) : axis === 'y' ? v3(0, 1, 0) : v3(0, 0, 1);
    const projected = sub(axisVector, scale(normal, dot(axisVector, normal)));
    const tangentLength = length(projected);
    if (tangentLength < 1e-12) return [clone(circle.center), clone(circle.center)];
    const offset = scale(projected, circle.radius / tangentLength);
    return [add(circle.center, offset), sub(circle.center, offset)];
  });
}

/** Reject collapsed, skewed or non-planar profiles before making a solid. */
export function isExtrudableProfile(corners: readonly Vec3[]): boolean {
  if (corners.length !== 4 || !corners.every(isFinite3)) return false;
  const [a, b, c, d] = corners;
  const u = sub(b, a);
  const v = sub(d, a);
  const width = length(u);
  const height = length(v);
  return width > 1e-6 && height > 1e-6 && length(cross(u, v)) > 1e-12
    && Math.abs(dot(normalize(u), normalize(v))) < 1e-6
    && distance(c, add(b, v)) <= Math.max(width, height) * 1e-6;
}

export function isValidCircle(circle: CircleGeometry): boolean {
  return !!circle.center && !!circle.normal && isFinite3(circle.center) && isFinite3(circle.normal)
    && Number.isFinite(length(circle.normal)) && length(circle.normal) > 1e-12
    && Number.isFinite(circle.radius) && circle.radius >= 1e-6;
}

export function isValidCylinder(cylinder: Pick<CylinderEntity, 'center' | 'normal' | 'radius' | 'depth'>): boolean {
  return isValidCircle(cylinder) && Number.isFinite(cylinder.depth) && Math.abs(cylinder.depth) >= 1e-6;
}

export function circleFrame(circle: Pick<CircleEntity, 'normal'>): { uDir: Vec3; vDir: Vec3 } {
  const normal = normalize(circle.normal);
  const reference = Math.abs(normal.z) < 0.9 ? v3(0, 0, 1) : v3(0, 1, 0);
  const uDir = normalize(cross(reference, normal));
  return { uDir, vDir: normalize(cross(normal, uDir)) };
}

export function circlePoints(circle: CircleGeometry, count = 96): Vec3[] {
  const { uDir, vDir } = circleFrame(circle);
  return Array.from({ length: count }, (_, index) => {
    const angle = index * Math.PI * 2 / count;
    return add(circle.center, add(scale(uDir, Math.cos(angle) * circle.radius), scale(vDir, Math.sin(angle) * circle.radius)));
  });
}

export function entityVertices(entity: Entity): Vertex[] {
  if (entity.type === 'circle') {
    return [entity.center, ...circlePoints(entity, 4)].map((point, index) => ({ entityId: entity.id, point, index }));
  }
  if (entity.type === 'cylinder') {
    const top = cylinderTopCenter(entity);
    const baseRing = circlePoints(entity, 4);
    const topRing = baseRing.map((point) => add(point, cylinderOffset(entity)));
    return [entity.center, ...baseRing, top, ...topRing].map((point, index) => ({ entityId: entity.id, point, index }));
  }
  return entityPoints(entity).map((point, index) => ({ entityId: entity.id, point, index }));
}

export function entitySegments(entity: Entity): Segment[] {
  if (entity.type === 'line') return [{ entityId: entity.id, a: entity.a, b: entity.b, index: 0 }];
  if (entity.type === 'circle') {
    const points = circlePoints(entity);
    return points.map((a, index) => ({ entityId: entity.id, a, b: points[(index + 1) % points.length], index, circle: entity }));
  }
  if (entity.type === 'cylinder') {
    const offset = cylinderOffset(entity);
    const base = circlePoints(entity);
    const top = base.map((point) => add(point, offset));
    const circleBase: CircleGeometry = { center: clone(entity.center), normal: clone(entity.normal), radius: entity.radius };
    const circleTop: CircleGeometry = { center: cylinderTopCenter(entity), normal: clone(entity.normal), radius: entity.radius };
    return [
      ...base.map((a, index) => ({ entityId: entity.id, a, b: base[(index + 1) % base.length], index, circle: circleBase })),
      ...top.map((a, index) => ({ entityId: entity.id, a, b: top[(index + 1) % top.length], index: index + base.length, circle: circleTop })),
      ...circlePoints(entity, 4).map((a, index) => ({
        entityId: entity.id,
        a,
        b: add(a, offset),
        index: index + base.length * 2,
      })),
    ];
  }
  const base = entity.corners.map((corner, index) => ({
    entityId: entity.id,
    a: corner,
    b: entity.corners[(index + 1) % 4],
    index,
  }));
  if (entity.type === 'rect') return base;
  const offset = extrusionOffset(entity);
  return [
    ...base,
    ...base.map((edge) => ({ ...edge, a: add(edge.a, offset), b: add(edge.b, offset), index: edge.index + 4 })),
    ...entity.corners.map((a, index) => ({ entityId: entity.id, a, b: add(a, offset), index: index + 8 })),
  ];
}

/** Quad faces used by both the renderer and face picking. */
export function entityFaces(entity: Entity): Vec3[][] {
  if (entity.type === 'line' || entity.type === 'circle') return [];
  if (entity.type === 'cylinder') {
    const base = circlePoints(entity);
    const offset = cylinderOffset(entity);
    const top = base.map((point) => add(point, offset));
    const positive = entity.depth >= 0;
    return [
      positive ? base.slice().reverse() : base,
      positive ? top : top.slice().reverse(),
      ...base.map((a, index) => positive
        ? [a, base[(index + 1) % base.length], top[(index + 1) % base.length], top[index]]
        : [a, top[index], top[(index + 1) % base.length], base[(index + 1) % base.length]]),
    ];
  }
  if (entity.type === 'rect') return [[...entity.corners]];
  const offset = extrusionOffset(entity);
  const base = entity.corners;
  const top = base.map((corner) => add(corner, offset));
  return [
    [...base], top,
    ...base.map((a, i) => [a, base[(i + 1) % 4], top[(i + 1) % 4], top[i]]),
  ];
}

export function entityMidpoints(entity: Entity): Vertex[] {
  if (entity.type === 'circle' || entity.type === 'cylinder') return [];
  return entitySegments(entity).map((segment) => ({
    entityId: entity.id,
    point: lerp(segment.a, segment.b, 0.5),
    index: segment.index,
  }));
}

export function entityCenter(entity: Entity): Vec3 {
  if (entity.type === 'line') return lerp(entity.a, entity.b, 0.5);
  if (entity.type === 'circle') return clone(entity.center);
  if (entity.type === 'cylinder') return add(entity.center, scale(cylinderOffset(entity), 0.5));
  const center = lerp(entity.corners[0], entity.corners[2], 0.5);
  return entity.type === 'extrusion' ? add(center, scale(extrusionOffset(entity), 0.5)) : center;
}

export function entityPoints(entity: Entity): Vec3[] {
  if (entity.type === 'line') return [entity.a, entity.b];
  if (entity.type === 'rect') return [...entity.corners];
  if (entity.type === 'circle') {
    return circleExtremaPoints(entity);
  }
  if (entity.type === 'cylinder') {
    return [...circleExtremaPoints(entity), ...circleExtremaPoints({
      center: cylinderTopCenter(entity),
      normal: entity.normal,
      radius: entity.radius,
    })];
  }
  const offset = extrusionOffset(entity);
  return [...entity.corners, ...entity.corners.map((corner) => add(corner, offset))];
}

export function translateEntity(entity: Entity, offset: Vec3): Entity {
  if (entity.type === 'line') return { ...entity, a: add(entity.a, offset), b: add(entity.b, offset) };
  if (entity.type === 'circle' || entity.type === 'cylinder') return { ...entity, center: add(entity.center, offset) };
  return { ...entity, corners: entity.corners.map((corner) => add(corner, offset)) as RectEntity['corners'] };
}

export function entityTriangles(entity: Entity): [Vec3, Vec3, Vec3][] {
  if (entity.type === 'circle') {
    const points = circlePoints(entity);
    return points.map((point, index) => [entity.center, point, points[(index + 1) % points.length]]);
  }
  if (entity.type === 'cylinder') {
    const base = circlePoints(entity);
    const top = base.map((point) => add(point, cylinderOffset(entity)));
    const baseCenter = entity.center;
    const topCenter = cylinderTopCenter(entity);
    const triangles: [Vec3, Vec3, Vec3][] = [];
    const positive = entity.depth >= 0;
    for (let index = 0; index < base.length; index += 1) {
      const next = (index + 1) % base.length;
      // Reverse the base winding so its normal points away from the solid for positive depth.
      const baseTriangle: [Vec3, Vec3, Vec3] = [baseCenter, base[next], base[index]];
      const topTriangle: [Vec3, Vec3, Vec3] = [topCenter, top[index], top[next]];
      const sideA: [Vec3, Vec3, Vec3] = [base[index], base[next], top[next]];
      const sideB: [Vec3, Vec3, Vec3] = [base[index], top[next], top[index]];
      const reverse = ([a, b, c]: [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] => [a, c, b];
      triangles.push(...(positive
        ? [baseTriangle, topTriangle, sideA, sideB]
        : [reverse(baseTriangle), reverse(topTriangle), reverse(sideA), reverse(sideB)]));
    }
    return triangles;
  }
  return entityFaces(entity).flatMap((face) => {
    if (face.length < 3) return [];
    const [origin, ...rest] = face;
    return rest.slice(1).map((point, index) => [origin, rest[index], point] as [Vec3, Vec3, Vec3]);
  });
}

export function describeEntity(entity: Entity): string {
  if (entity.type === 'line') return `line ${formatMm(lineLength(entity))}`;
  if (entity.type === 'circle') return `circle diameter ${formatMm(entity.radius * 2)}`;
  if (entity.type === 'cylinder') return `cylinder diameter ${formatMm(entity.radius * 2)} x depth ${formatMm(entity.depth)}`;
  const { width, height } = rectFrame(entity);
  if (entity.type === 'extrusion') return `extrusion ${formatMm(width)} x ${formatMm(height)} x ${formatMm(entity.depth)}`;
  return `rectangle ${formatMm(width)} x ${formatMm(height)}`;
}

export function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} mm`;
}

function validateInput(input: EntityInput): void {
  if (!['line', 'rect', 'extrusion', 'circle', 'cylinder'].includes(input.type)) throw new Error('unsupported entity type');
  if (input.type === 'circle') {
    if (!isValidCircle(input)) throw new Error('a circle needs a finite center, a non-zero normal, and a positive radius');
    return;
  }
  if (input.type === 'cylinder') {
    if (!isValidCylinder(input)) throw new Error('a cylinder needs a finite circle and a non-zero finite depth');
    return;
  }
  const points = input.type === 'line' ? [input.a, input.b] : input.corners;
  if (input.type !== 'line' && input.corners.length !== 4) throw new Error('a rectangle needs four corners');
  for (const point of points) {
    if (!isFinite3(point)) throw new Error('entity coordinates must be finite');
  }
  if (input.type === 'extrusion') {
    if (!isExtrudableProfile(input.corners)) throw new Error('extrusion needs a planar rectangle with non-zero sides');
    if (!Number.isFinite(input.depth) || Math.abs(input.depth) < 1e-6) throw new Error('extrusion depth must be finite and non-zero');
  }
}

/**
 * The sketch model: a list of entities plus an undo/redo command stack.
 * Every mutation goes through `execute`, so undo/redo and change events
 * stay consistent whether the change came from a pen stroke, a key, a
 * measurement edit, or (later) a voice/AI command.
 */
export class Sketch {
  private entities: Entity[] = [];
  private undoStack: SketchCommand[] = [];
  private redoStack: SketchCommand[] = [];
  private listeners = new Set<SketchListener>();
  private nextId = 1;

  get all(): readonly Entity[] {
    return this.entities;
  }

  get size(): number {
    return this.entities.length;
  }

  get last(): Entity | undefined {
    return this.entities[this.entities.length - 1];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get(id: string): Entity | undefined {
    return this.entities.find((entity) => entity.id === id);
  }

  onChange(listener: SketchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(reason: string): void {
    for (const listener of this.listeners) listener(reason);
  }

  execute(command: SketchCommand): void {
    command.apply();
    this.undoStack.push(command);
    this.redoStack.length = 0;
    this.emit(command.label);
  }

  undo(): string | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    command.revert();
    this.redoStack.push(command);
    this.emit(`undo ${command.label}`);
    return command.label;
  }

  redo(): string | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    command.apply();
    this.undoStack.push(command);
    this.emit(`redo ${command.label}`);
    return command.label;
  }

  private allocateId(): string {
    return `e${this.nextId++}`;
  }

  private materialize(input: EntityInput, id: string): Entity {
    if (input.type === 'line') return { id, type: 'line', a: clone(input.a), b: clone(input.b) };
    if (input.type === 'extrusion') return { id, type: 'extrusion', corners: input.corners.map(clone) as RectEntity['corners'], depth: input.depth };
    if (input.type === 'circle') return { id, type: 'circle', center: clone(input.center), normal: normalize(input.normal), radius: input.radius };
    if (input.type === 'cylinder') return {
      id,
      type: 'cylinder',
      center: clone(input.center),
      normal: normalize(input.normal),
      radius: input.radius,
      depth: input.depth,
    };
    return { id, type: 'rect', corners: input.corners.map(clone) as [Vec3, Vec3, Vec3, Vec3] };
  }

  addEntity(input: EntityInput, label?: string): Entity {
    validateInput(input);
    const entity = this.materialize(input, this.allocateId());
    this.execute({
      label: label ?? `add ${entity.type}`,
      apply: () => {
        this.entities = [...this.entities, entity];
      },
      revert: () => {
        this.entities = this.entities.filter((candidate) => candidate.id !== entity.id);
      },
    });
    return entity;
  }

  removeEntity(id: string, label?: string): boolean {
    const index = this.entities.findIndex((entity) => entity.id === id);
    if (index < 0) return false;
    const removed = this.entities[index];
    this.execute({
      label: label ?? `delete ${removed.type}`,
      apply: () => {
        this.entities = this.entities.filter((entity) => entity.id !== id);
      },
      revert: () => {
        const next = [...this.entities];
        next.splice(Math.min(index, next.length), 0, removed);
        this.entities = next;
      },
    });
    return true;
  }

  replaceEntity(id: string, input: EntityInput, label?: string): Entity | null {
    const index = this.entities.findIndex((entity) => entity.id === id);
    if (index < 0) return null;
    validateInput(input);
    const previous = this.entities[index];
    const next = this.materialize(input, id);
    this.execute({
      label: label ?? `edit ${next.type}`,
      apply: () => {
        this.entities = this.entities.map((entity) => (entity.id === id ? next : entity));
      },
      revert: () => {
        this.entities = this.entities.map((entity) => (entity.id === id ? previous : entity));
      },
    });
    return next;
  }

  replaceEntities(inputs: readonly (EntityInput & { id: string })[], label?: string): Entity[] | null {
    if (!inputs.length) return [];
    const ids = new Set(inputs.map((input) => input.id));
    if (ids.size !== inputs.length || inputs.some((input) => !this.get(input.id))) return null;
    const previous = new Map(this.entities.filter((entity) => ids.has(entity.id)).map((entity) => [entity.id, entity]));
    const next = inputs.map((input) => {
      validateInput(input);
      return this.materialize(input, input.id);
    });
    const replacements = new Map(next.map((entity) => [entity.id, entity]));
    this.execute({
      label: label ?? `edit ${next.length} entities`,
      apply: () => {
        this.entities = this.entities.map((entity) => replacements.get(entity.id) ?? entity);
      },
      revert: () => {
        this.entities = this.entities.map((entity) => previous.get(entity.id) ?? entity);
      },
    });
    return next;
  }

  clear(): number {
    const removed = this.entities;
    if (!removed.length) return 0;
    this.execute({
      label: `clear ${removed.length} entities`,
      apply: () => {
        this.entities = [];
      },
      revert: () => {
        this.entities = removed;
      },
    });
    return removed.length;
  }

  vertices(): Vertex[] {
    return this.entities.flatMap(entityVertices);
  }

  midpoints(): Vertex[] {
    return this.entities.flatMap(entityMidpoints);
  }

  segments(): Segment[] {
    return this.entities.flatMap(entitySegments);
  }

  boundingBox(): BoundingBox | null {
    let box: BoundingBox | null = null;
    for (const entity of this.entities) {
      for (const point of entityPoints(entity)) {
        if (!box) {
          box = { min: clone(point), max: clone(point) };
          continue;
        }
        box.min = v3(Math.min(box.min.x, point.x), Math.min(box.min.y, point.y), Math.min(box.min.z, point.z));
        box.max = v3(Math.max(box.max.x, point.x), Math.max(box.max.y, point.y), Math.max(box.max.z, point.z));
      }
    }
    return box;
  }

  /** Orbit pivot: bounding-box centre, or the origin when the sketch is empty. */
  center(): Vec3 {
    const box = this.boundingBox();
    return box ? lerp(box.min, box.max, 0.5) : v3(0, 0, 0);
  }

  toJSON(): SketchJSON {
    return {
      version: 1,
      units: 'mm',
      entities: this.entities.map((entity) => this.materialize(entity, entity.id)),
    };
  }

  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  /** Replace the contents without touching history (e.g. loading a file). */
  load(data: SketchJSON): void {
    const entities: Entity[] = [];
    let maxId = 0;
    for (const raw of data.entities ?? []) {
      const input = raw as EntityInput & { id?: string };
      validateInput(input);
      const id = typeof input.id === 'string' && input.id ? input.id : this.allocateId();
      const numeric = Number(id.replace(/^e/, ''));
      if (Number.isFinite(numeric)) maxId = Math.max(maxId, numeric);
      entities.push(this.materialize(input, id));
    }
    this.entities = entities;
    this.nextId = Math.max(this.nextId, maxId + 1);
    this.undoStack = [];
    this.redoStack = [];
    this.emit('load');
  }

  static fromJSON(data: SketchJSON): Sketch {
    const sketch = new Sketch();
    sketch.load(data);
    return sketch;
  }
}
