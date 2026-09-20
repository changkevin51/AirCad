import { describe, expect, it } from 'vitest';
import { Commands, parseDepth } from './commands';
import { ExtrusionSession } from './extrusion';
import { entityCenter, entityFaces, entityPoints, entityTriangles, extrusionNormal, makeRect, Sketch, type Entity, type ExtrusionEntity, type PrismEntity, type RectEntity, type TriangleEntity } from './sketch';
import { add, normalize, v2, v3 } from './vec';

const profile = (u = v3(1, 0, 0), v = v3(0, 1, 0)): RectEntity => ({
  id: 'e1', type: 'rect', corners: makeRect(v3(100, 200, 300), u, v, 400, 250),
});

describe('extruded geometry and commands', () => {
  it.each([
    [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)],
    [v3(1, 0, 0), v3(0, 0, 1), v3(0, 1, 0)],
    [v3(0, 1, 0), v3(0, 0, 1), v3(1, 0, 0)],
  ])('extrudes on every work plane regardless of winding', (u, v, normal) => {
    const rect = profile(u, v);
    for (const actual of [extrusionNormal(rect), extrusionNormal({ ...rect, corners: [rect.corners[0], rect.corners[3], rect.corners[2], rect.corners[1]] })]) {
      for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(normal[axis]);
    }
    const solid: ExtrusionEntity = { ...rect, type: 'extrusion', depth: -100 };
    const top = entityPoints(solid)[4];
    expect(top).toEqual(v3(100 - 100 * normal.x, 200 - 100 * normal.y, 300 - 100 * normal.z));
    expect(entityFaces(solid)).toHaveLength(6);
  });

  it('commits as one undoable edit and exports a solid with a signed vector', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    sketch.addEntity(profile());
    const original = sketch.serialize();
    expect(commands.extrude('e1', -600).ok).toBe(true);
    expect(sketch.size).toBe(1);
    expect(sketch.vertices()).toHaveLength(8);
    expect(sketch.segments()).toHaveLength(12);
    expect(sketch.midpoints()).toHaveLength(12);
    expect(sketch.boundingBox()).toEqual({ min: v3(100, 200, -300), max: v3(500, 450, 300) });
    expect(entityCenter(sketch.last!)).toEqual(v3(300, 325, 0));
    expect(commands.exportPayload().entities[0]).toEqual({
      type: 'extrusion', points: [[100, 200, 300], [500, 200, 300], [500, 450, 300], [100, 450, 300]], vector: [-0, -0, -600],
    });
    const saved = sketch.serialize();
    expect(Sketch.fromJSON(JSON.parse(saved)).serialize()).toBe(saved);
    expect(commands.undo()).toBe('extrude -600 mm');
    expect(sketch.serialize()).toBe(original);
    commands.redo();
    expect(sketch.serialize()).toBe(saved);
    commands.deleteEntity('e1');
    expect(sketch.size).toBe(0);
    commands.undo();
    expect(sketch.serialize()).toBe(saved);
  });

  it('edits depth or base dimensions without flattening an existing solid', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    sketch.addEntity(profile());
    commands.extrude('e1', 300);
    expect(commands.setDimension('e1', '-2 m').ok).toBe(true);
    expect((sketch.last as ExtrusionEntity).depth).toBe(-2000);
    expect(commands.setDimension('e1', '800x500').ok).toBe(true);
    expect(sketch.last?.type).toBe('extrusion');
    expect((sketch.last as ExtrusionEntity).depth).toBe(-2000);
    expect((sketch.last as ExtrusionEntity).corners[2]).toEqual(v3(900, 700, 300));
    const saved = sketch.serialize();
    expect(commands.setDimension('e1', { width: Infinity, height: 10 }).ok).toBe(false);
    expect(sketch.serialize()).toBe(saved);
  });

  it('rejects lines, invalid depths and malformed profiles without touching history', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const rect = sketch.addEntity(profile());
    const line = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(10, 0, 0) });
    const saved = sketch.serialize();
    for (const depth of [0, NaN, Infinity, -Infinity]) expect(commands.extrude(rect.id, depth).ok).toBe(false);
    expect(commands.extrude(line.id, 100).ok).toBe(false);
    expect(commands.extrude('missing', 100).ok).toBe(false);
    expect(sketch.serialize()).toBe(saved);
    const corners = profile().corners;
    corners[2].z += 10;
    const warped = sketch.addEntity({ type: 'rect', corners });
    expect(commands.extrude(warped.id, 100).ok).toBe(false);
    expect(() => sketch.addEntity({ type: 'extrusion', corners, depth: 100 })).toThrow();
    expect(() => sketch.addEntity({ type: 'extrusion', corners: profile().corners, depth: NaN })).toThrow();
  });

  it('accepts signed exact depths with units and rejects zero / multiple dimensions', () => {
    expect(parseDepth('-2.5 m')).toBe(-2500);
    expect(parseDepth('30cm')).toBe(300);
    for (const value of ['0', '1x2', 'Infinity', 'banana', '']) expect(parseDepth(value)).toBeNull();
  });
});

describe('extrusion on generic outlines', () => {
  it('extrudes a sloped triangle in either winding and sign', () => {
    const u = normalize(v3(1, 0, 1));
    const v = normalize(v3(-1, 2, 1));
    const base = v3(1000, -500, 200);
    const local = [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)];
    const corners = local.map((p) => add(add(base, { x: p.x * u.x, y: p.x * u.y, z: p.x * u.z }), { x: p.y * v.x, y: p.y * v.y, z: p.y * v.z }));
    for (const ring of [corners, [...corners].reverse()]) {
      for (const depth of [120, -120]) {
        const sketch = new Sketch();
        const solid = sketch.addEntity({ type: 'extrusion', corners: ring, depth }) as ExtrusionEntity;
        const normal = extrusionNormal(solid);
        const top = solid.corners.map((corner) => add(corner, { x: normal.x * depth, y: normal.y * depth, z: normal.z * depth }));
        const topFace = entityFaces(solid).find((face) => face.every((p) => top.some((q) => Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9 && Math.abs(q.z - p.z) < 1e-9)));
        expect(topFace).toBeDefined();
        for (const triangle of entityTriangles(solid)) {
          for (const point of triangle) expect(Number.isFinite(point.x + point.y + point.z)).toBe(true);
        }
      }
    }
  });

  it('keeps every original vertex fixed when a cap is pulled; only depth or position changes', () => {
    const triangle: Entity = { id: 't', type: 'extrusion', corners: [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)], depth: 200 };
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const stored = sketch.addEntity({ type: 'extrusion', corners: (triangle as ExtrusionEntity).corners, depth: 200 });
    const result = commands.extrude(stored.id, 350);
    expect(result.ok).toBe(true);
    const next = sketch.get(stored.id) as ExtrusionEntity;
    expect(next.corners).toEqual((triangle as ExtrusionEntity).corners);
    expect(next.depth).toBe(350);
  });
});

describe('extrusion gesture transaction', () => {
  const UP = v2(0, -1);

  it('moves only while grabbed and can be re-grabbed without a depth jump', () => {
    const session = new ExtrusionSession(profile(), 10, 100, 0);
    session.update(v2(100, 300), false, 'keycap:1', UP);
    session.update(v2(100, 200), false, 'keycap:1', UP);
    expect(session.depth).toBe(0);
    session.update(v2(100, 200), true, 'keycap:1', UP);
    session.update(v2(500, 146), true, 'keycap:1', UP);
    expect(session.depth).toBe(500);
    session.update(v2(500, 50), false, 'keycap:1', UP);
    expect(session.depth).toBe(500);
    expect(session.dragging).toBe(false);
    session.update(v2(100, 300), true, 'keycap:1', UP);
    expect(session.depth).toBe(500);
    session.update(v2(100, 350), true, 'keycap:1', UP);
    expect(session.depth).toBe(0);
    session.update(v2(100, 375), true, 'keycap:1', UP);
    expect(session.depth).toBe(-200);
  });

  it('freezes on tracking loss or keycap switch until a fresh Space grab', () => {
    const session = new ExtrusionSession(profile(), 10, 0, 0);
    session.update(v2(0, 300), true, 'keycap:1', UP);
    session.update(v2(0, 250), true, 'keycap:1', UP);
    session.update(null, false, null, UP);
    session.update(v2(0, 0), true, 'keycap:1', UP);
    expect(session.depth).toBe(500);
    expect(session.dragging).toBe(false);
    session.update(v2(0, 250), false, 'keycap:1', UP);
    session.update(v2(0, 250), true, 'keycap:1', UP);
    session.update(v2(0, 200), true, 'keycap:1', UP);
    expect(session.depth).toBe(1000);
    session.update(v2(0, 0), true, 'keycap:2', UP);
    expect(session.depth).toBe(1000);
    expect(session.dragging).toBe(false);
  });

  it('rebases a continuing grip after camera navigation without a pull jump', () => {
    const session = new ExtrusionSession(profile(), 10, 0, 0);
    session.update(v2(0, 300), true, 'keycap:1', UP);
    session.update(v2(0, 250), true, 'keycap:1', UP);
    const corners = session.corners;
    session.pause(false);
    expect(session.dragging).toBe(false);
    expect(session.depth).toBe(500);
    expect(session.corners).toBe(corners);
    session.update(v2(700, 50), true, 'keycap:1', UP);
    expect(session.depth).toBe(500);
    expect(session.dragging).toBe(true);
    session.update(v2(700, 40), true, 'keycap:1', UP);
    expect(session.depth).toBe(600);
  });

  it('does not clear a safety pause when camera navigation pauses the grip', () => {
    const session = new ExtrusionSession(profile(), 10, 0, 0);
    session.update(v2(0, 300), true, 'keycap:1', UP);
    session.update(v2(0, 250), true, 'keycap:1', UP);
    session.pause();
    session.pause(false);
    session.update(v2(700, 50), true, 'keycap:1', UP);
    expect(session.depth).toBe(500);
    expect(session.dragging).toBe(false);
    session.update(v2(700, 50), false, 'keycap:1', UP);
    session.update(v2(700, 50), true, 'keycap:1', UP);
    session.update(v2(700, 40), true, 'keycap:1', UP);
    expect(session.depth).toBe(600);
  });

  it('still requires a release when the cursor source changes after a soft pause', () => {
    const session = new ExtrusionSession(profile(), 10, 0, 0);
    session.update(v2(0, 300), true, 'keycap:1', UP);
    session.update(v2(0, 250), true, 'keycap:1', UP);
    session.pause(false);
    session.update(v2(700, 50), true, 'keycap:2', UP);
    expect(session.depth).toBe(500);
    expect(session.dragging).toBe(false);
    session.update(v2(700, 50), false, 'keycap:2', UP);
    session.update(v2(700, 50), true, 'keycap:2', UP);
    session.update(v2(700, 40), true, 'keycap:2', UP);
    expect(session.depth).toBe(600);
  });

  it('keeps previews out of history and preserves exact depths when re-editing', () => {
    const sketch = new Sketch();
    sketch.addEntity(profile());
    const saved = sketch.serialize();
    const session = new ExtrusionSession(sketch.last as RectEntity, 10, 100, 0);
    session.update(v2(0, 300), true, 'mouse', UP);
    session.update(v2(0, 200), true, 'mouse', UP);
    expect(session.preview.depth).toBe(1000);
    expect(sketch.serialize()).toBe(saved);
    expect(sketch.undo()).toBe('add rect');
    const edit = new ExtrusionSession({ ...profile(), type: 'extrusion', depth: 123 }, 10, 100, 0);
    edit.update(v2(0, 300), true, 'mouse', UP);
    edit.update(v2(0, 301), true, 'mouse', UP);
    expect(edit.depth).toBe(123);
    edit.setDepth(-251);
    edit.update(v2(0, 100), true, 'mouse', UP);
    expect(edit.depth).toBe(-251);
  });

  it('reports geometry changes without treating face selection as an edit', () => {
    const session = new ExtrusionSession(profile(), 1, 0, 0);
    expect(session.changed).toBe(false);
    session.setPull(100);
    expect(session.changed).toBe(true);
    session.setPull(0);
    expect(session.changed).toBe(false);
    session.setFace(1);
    expect(session.changed).toBe(false);
    const box = new ExtrusionSession({ ...profile(), type: 'extrusion', depth: 300 }, 1, 0, 0);
    expect(box.changed).toBe(false);
    box.setFace(2);
    expect(box.changed).toBe(false);
    box.setPull(50);
    expect(box.depth).toBe(300);
    expect(box.changed).toBe(true);
  });
});

describe('face pull measurement', () => {
  const UP = v2(0, -1);
  const box = (depth = 80): ExtrusionEntity => ({ ...profile(), type: 'extrusion', depth });

  it('latches the first clear outward direction once the grab moves 12 projected pixels', () => {
    const session = new ExtrusionSession(box(), 1, 0, 0);
    session.update(v2(300, 300), true, 'mouse', UP);
    session.update(v2(300, 295), true, 'mouse', UP);
    expect(session.measurement).toBeNull();
    session.update(v2(300, 288), true, 'mouse', UP);
    const measurement = session.measurement!;
    expect(measurement.axis).toBe('n');
    expect(measurement.sign).toBe(1);
    expect(measurement.direction).toBe(1);
    expect(measurement.base).toEqual(box());
    measurement.base.corners[0].x = -1;
    measurement.direction = -1;
    expect(session.measurement!.base.corners[0].x).toBe(100);
    expect(session.measurement!.direction).toBe(1);
  });

  it('latches inward as -1', () => {
    const session = new ExtrusionSession(box(), 1, 0, 0);
    session.update(v2(300, 300), true, 'mouse', UP);
    session.update(v2(300, 337), true, 'mouse', UP);
    expect(session.measurement!.direction).toBe(-1);
  });

  it('keeps the measurement across release and pause but clears it on a fresh grab', () => {
    const session = new ExtrusionSession(box(), 1, 0, 0);
    session.update(v2(300, 300), true, 'mouse', UP);
    session.update(v2(300, 263), true, 'mouse', UP);
    expect(session.measurement).not.toBeNull();
    session.update(v2(300, 263), false, 'mouse', UP);
    expect(session.measurement).not.toBeNull();
    session.pause();
    expect(session.measurement).not.toBeNull();
    session.update(v2(300, 263), true, 'mouse', UP);
    expect(session.measurement).not.toBeNull();
    session.update(v2(300, 263), false, 'mouse', UP);
    session.update(v2(500, 500), true, 'mouse', UP);
    expect(session.measurement).toBeNull();
    session.update(v2(500, 463), true, 'mouse', UP);
    expect(session.measurement).not.toBeNull();
  });

  it('clears the measurement when the face changes or an exact value is typed', () => {
    const session = new ExtrusionSession(box(), 1, 0, 0);
    session.update(v2(300, 300), true, 'mouse', UP);
    session.update(v2(300, 263), true, 'mouse', UP);
    session.update(v2(300, 263), false, 'mouse', UP);
    expect(session.setFace(2)).toBe(true);
    expect(session.measurement).toBeNull();
    session.update(v2(300, 300), true, 'mouse', UP);
    session.update(v2(300, 263), true, 'mouse', UP);
    expect(session.measurement).not.toBeNull();
    session.setPull(40);
    expect(session.measurement).toBeNull();
    session.update(v2(300, 300), false, 'mouse', UP);
    session.update(v2(300, 300), true, 'mouse', UP);
    session.update(v2(300, 263), true, 'mouse', UP);
    expect(session.measurement).not.toBeNull();
    session.setDepth(-50);
    expect(session.measurement).toBeNull();
  });

  it('snapshots the pending preview as a fresh grab baseline without touching the preview on read', () => {
    const session = new ExtrusionSession(profile(), 1, 0, 0);
    session.update(v2(300, 300), true, 'mouse', UP);
    session.update(v2(300, 280), true, 'mouse', UP);
    session.update(v2(300, 280), false, 'mouse', UP);
    session.update(v2(500, 500), true, 'mouse', UP);
    session.update(v2(500, 463), true, 'mouse', UP);
    const measurement = session.measurement!;
    expect(measurement.base.type).toBe('extrusion');
    expect((measurement.base as ExtrusionEntity).depth).toBeCloseTo(20);
    const before = { depth: session.depth, corners: session.corners, pull: session.pulled };
    expect(session.measurement).toEqual(measurement);
    expect({ depth: session.depth, corners: session.corners, pull: session.pulled }).toEqual(before);
  });

  it('rejects a pull when two finite operands overflow the depth', () => {
    const solid: ExtrusionEntity = {
      id: 't', type: 'extrusion',
      corners: [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)],
      depth: 1e308,
    };
    const session = new ExtrusionSession(solid, 1, 0, 0);
    const before = { depth: session.depth, corners: session.corners.map((corner) => ({ ...corner })), pull: session.pulled };
    expect(session.setPull(1e308)).toBe(false);
    expect(session.depth).toBe(before.depth);
    expect(session.corners).toEqual(before.corners);
    expect(session.pulled).toBe(before.pull);
    expect(session.error).toBeTruthy();
  });
});

describe('triangular prism extrusion session', () => {
  const UP = v2(0, -1);
  const tri = (): TriangleEntity => ({ id: 't', type: 'triangle', corners: [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)] });
  const prism = (depth: number): PrismEntity => ({ id: 'p', type: 'prism', corners: tri().corners, depth });

  it('pulls a flat triangle into a five-faced prism without touching the model', () => {
    const sketch = new Sketch();
    const entity = sketch.addEntity({ type: 'triangle', corners: tri().corners }) as TriangleEntity;
    const saved = sketch.serialize();
    const session = new ExtrusionSession(entity, 10, 100, 0);
    expect(session.faces).toHaveLength(2);
    expect(session.preview).toMatchObject({ id: entity.id, type: 'prism', depth: 0 });
    session.update(v2(0, 300), true, 'mouse', UP);
    session.update(v2(0, 250), true, 'mouse', UP);
    expect(session.depth).toBe(500);
    expect(session.faces).toHaveLength(5);
    expect(session.currentFaces()).toHaveLength(5);
    expect(session.preview.corners).toEqual(entity.corners);
    expect(sketch.serialize()).toBe(saved);
    expect(sketch.undo()).toBe('add triangle');
  });

  it('cycles all five faces on release but never while gripped', () => {
    const session = new ExtrusionSession(tri(), 1, 0, 0);
    session.setPull(100);
    expect(session.faces).toHaveLength(5);
    const preview = structuredClone(session.preview);
    for (const index of [1, 2, 3, 4, 0]) {
      expect(session.cycleFace()).toBe(true);
      expect(session.faceIndex).toBe(index);
      expect(session.face).toEqual(session.currentFaces()[index]);
      expect(session.preview).toEqual(preview);
    }
    expect(session.faces.filter((face) => face.axis === 'edge').map((face) => face.edgeIndex)).toEqual([0, 1, 2]);
    session.update(v2(0, 300), false, 'mouse', UP);
    session.update(v2(0, 300), true, 'mouse', UP);
    session.update(v2(0, 290), true, 'mouse', UP);
    expect(session.dragging).toBe(true);
    expect(session.setFace(1)).toBe(false);
    expect(session.cycleFace()).toBe(false);
    session.update(v2(0, 290), false, 'mouse', UP);
    expect(session.cycleFace()).toBe(true);
    expect(session.faceIndex).toBe(1);
  });

  it('keeps side face identity across refreshes and regrips without a depth jump', () => {
    const session = new ExtrusionSession(prism(123), 10, 0, 0);
    expect(session.depth).toBe(123);
    expect(session.setFace(2)).toBe(true);
    expect(session.face.edgeIndex).toBe(0);
    session.update(v2(0, 300), true, 'mouse', UP);
    session.update(v2(0, 250), true, 'mouse', UP);
    expect(session.depth).toBe(123);
    expect(session.face.axis).toBe('edge');
    expect(session.face.edgeIndex).toBe(0);
    session.update(v2(0, 250), false, 'mouse', UP);
    session.update(v2(10, 100), true, 'mouse', UP);
    expect(session.depth).toBe(123);
    expect(session.dragging).toBe(true);
    expect(session.face.edgeIndex).toBe(0);
  });

  it('tracks prism changes and exact signed depth edits like other solids', () => {
    const session = new ExtrusionSession(tri(), 1, 0, 0);
    expect(session.changed).toBe(false);
    session.setPull(100);
    expect(session.changed).toBe(true);
    expect(session.preview.type).toBe('prism');
    session.setDepth(-250);
    expect(session.depth).toBe(-250);
    expect(session.preview).toMatchObject({ type: 'prism', depth: -250 });
    session.setDepth(0);
    expect(session.changed).toBe(false);
    const edit = new ExtrusionSession(prism(100), 1, 0, 0);
    expect(edit.changed).toBe(false);
    edit.setFace(1);
    expect(edit.changed).toBe(false);
    edit.setPull(50);
    expect(edit.depth).toBe(150);
    expect(edit.changed).toBe(true);
  });
});
