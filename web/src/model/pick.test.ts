import { describe, expect, it } from 'vitest';
import { pickFace } from './pick';
import { makeRect, type CircleEntity, type RectEntity, type ExtrusionEntity } from './sketch';
import { frontViewProjector, topViewProjector } from './test-helpers';
import { v2, v3 } from './vec';

const rect: RectEntity = { id: 'r', type: 'rect', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300) };

describe('face selection', () => {
  it('selects rectangle interiors and excludes points outside or behind the camera', () => {
    const projector = topViewProjector();
    expect(pickFace([rect], v2(420, 285), projector)?.id).toBe('r');
    expect(pickFace([rect], v2(450, 285), projector)).toBeNull();
    expect(pickFace([rect], v2(420, 285), { ...projector, ray: () => ({ origin: v3(200, 150, -100), dir: v3(0, 0, -1) }) })).toBeNull();
  });

  it('selects the closest face among overlapping shapes regardless of entity order', () => {
    const near: RectEntity = { ...rect, id: 'near', corners: rect.corners.map((p) => ({ ...p, z: 100 })) as RectEntity['corners'] };
    for (const entities of [[near, rect], [rect, near]]) expect(pickFace(entities, v2(420, 285), topViewProjector())?.id).toBe('near');
  });

  it('selects the cap and side faces of an extruded solid', () => {
    const solid: ExtrusionEntity = { ...rect, id: 'solid', type: 'extrusion', depth: 200 };
    expect(pickFace([solid], v2(420, 285), topViewProjector())?.id).toBe('solid');
    expect(pickFace([solid], v2(420, 290), frontViewProjector())?.id).toBe('solid');
    expect(pickFace([rect], v2(420, 290), frontViewProjector())).toBeNull();
  });

  it('selects a circle inside its disk and nowhere else', () => {
    const circle: CircleEntity = { id: 'c', type: 'circle', center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: 100 };
    const projector = topViewProjector(1, 0, 0);
    expect(pickFace([circle], v2(0, 0), projector)?.id).toBe('c');
    expect(pickFace([circle], v2(99.99, 0), projector)?.id).toBe('c');
    expect(pickFace([circle], v2(101, 0), projector)).toBeNull();
    expect(pickFace([circle], v2(90, 90), projector)).toBeNull();
    expect(pickFace([circle], v2(0, 0), { ...projector, ray: () => ({ origin: v3(0, 0, -100), dir: v3(0, 0, -1) }) })).toBeNull();
    expect(pickFace([circle], v2(0, 0), { ...projector, ray: () => ({ origin: v3(-1000, 0, 0), dir: v3(1, 0, 0) }) })).toBeNull();
  });

  it('selects a circle standing in the XZ plane', () => {
    const circle: CircleEntity = { id: 'c', type: 'circle', center: v3(0, 0, 0), normal: v3(0, 1, 0), radius: 100 };
    const projector = frontViewProjector(1, 0, 0);
    expect(pickFace([circle], v2(0, 0), projector)?.id).toBe('c');
    expect(pickFace([circle], v2(0, 101), projector)).toBeNull();
  });

  it('prefers the nearer of an overlapping circle and rectangle regardless of order', () => {
    const circle: CircleEntity = { id: 'c', type: 'circle', center: v3(0, 0, 100), normal: v3(0, 0, 1), radius: 100 };
    const projector = topViewProjector(1, 0, 0);
    for (const entities of [[circle, rect], [rect, circle]]) {
      expect(pickFace(entities, v2(0, 0), projector)?.id).toBe('c');
    }
  });
});
