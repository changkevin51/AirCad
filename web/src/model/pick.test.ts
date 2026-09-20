import { describe, expect, it } from 'vitest';
import { pickFace } from './pick';
import { makeRect, type ExtrusionEntity, type PrismEntity, type RectEntity, type TriangleEntity } from './sketch';
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




  it('selects triangle interiors, prism caps and sides, and rejects behind-camera hits', () => {
    const triangle: TriangleEntity = { id: 't', type: 'triangle', corners: [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)] };
    const top = topViewProjector(1, 0, 0);
    expect(pickFace([triangle], v2(50, -50), top)?.id).toBe('t');
    expect(pickFace([triangle], v2(250, -250), top)).toBeNull();
    expect(pickFace([triangle], v2(50, -50), { ...top, ray: () => ({ origin: v3(50, 50, -100), dir: v3(0, 0, -1) }) })).toBeNull();

    const prism: PrismEntity = { id: 'p', type: 'prism', corners: triangle.corners.map((point) => ({ ...point })) as TriangleEntity['corners'], depth: 100 };
    expect(pickFace([prism], v2(50, -50), top)?.id).toBe('p');
    expect(pickFace([prism], v2(150, -50), frontViewProjector(1, 0, 0))?.id).toBe('p');
    expect(pickFace([triangle], v2(150, -50), frontViewProjector(1, 0, 0))).toBeNull();
  });

  it('prefers the nearer of an overlapping triangle or prism and a rectangle', () => {
    const near: TriangleEntity = { id: 'near', type: 'triangle', corners: [v3(0, 0, 100), v3(300, 0, 100), v3(0, 300, 100)] };
    const top = topViewProjector(1, 0, 0);
    for (const entities of [[near, rect], [rect, near]]) {
      expect(pickFace(entities, v2(50, -50), top)?.id).toBe('near');
    }
    const prism: PrismEntity = { id: 'p', type: 'prism', corners: [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)], depth: 50 };
    for (const entities of [[prism, rect], [rect, prism]]) {
      expect(pickFace(entities, v2(50, -50), top)?.id).toBe('p');
    }
  });
});
