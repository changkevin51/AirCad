import { describe, expect, it } from 'vitest';
import { Commands, parseDepth } from './commands';
import { ExtrusionSession } from './extrusion';
import { entityCenter, entityFaces, entityPoints, extrusionNormal, makeRect, Sketch, type RectEntity, type ExtrusionEntity } from './sketch';
import { v2, v3 } from './vec';

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

describe('extrusion gesture transaction', () => {
  const UP = v2(0, -1);

  it('moves only while grabbed and can be re-grabbed without a depth jump', () => {
    const session = new ExtrusionSession(profile(), 10, 100, 0);
    session.update(v2(100, 300), false, 'hand:1', UP);
    session.update(v2(100, 200), false, 'hand:1', UP);
    expect(session.depth).toBe(0);
    session.update(v2(100, 200), true, 'hand:1', UP);
    session.update(v2(500, 146), true, 'hand:1', UP);
    expect(session.depth).toBe(500);
    session.update(v2(500, 50), false, 'hand:1', UP);
    expect(session.depth).toBe(500);
    expect(session.dragging).toBe(false);
    session.update(v2(100, 300), true, 'hand:1', UP);
    expect(session.depth).toBe(500);
    session.update(v2(100, 350), true, 'hand:1', UP);
    expect(session.depth).toBe(0);
    session.update(v2(100, 375), true, 'hand:1', UP);
    expect(session.depth).toBe(-200);
  });

  it('freezes on tracking loss or hand switch until a fresh pinch', () => {
    const session = new ExtrusionSession(profile(), 10, 0, 0);
    session.update(v2(0, 300), true, 'hand:1', UP);
    session.update(v2(0, 250), true, 'hand:1', UP);
    session.update(null, false, null, UP);
    session.update(v2(0, 0), true, 'hand:1', UP);
    expect(session.depth).toBe(500);
    expect(session.dragging).toBe(false);
    session.update(v2(0, 250), false, 'hand:1', UP);
    session.update(v2(0, 250), true, 'hand:1', UP);
    session.update(v2(0, 200), true, 'hand:1', UP);
    expect(session.depth).toBe(1000);
    session.update(v2(0, 0), true, 'hand:2', UP);
    expect(session.depth).toBe(1000);
    expect(session.dragging).toBe(false);
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
});
