import { describe, expect, it } from 'vitest';
import { pickFace } from './pick';
import { makeRect, type CircleEntity, type Entity, type ExtrusionEntity, type PrismEntity, type RectEntity, type TriangleEntity } from './sketch';
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

  it('selects the interior of a triangle and a concave outline, but not the notch', () => {
    const projector = topViewProjector(1, 0, 0);
    const pick = (entity: Entity, x: number, y: number) => pickFace([entity], v2(x, -y), projector)?.id ?? null;
    const triangle: Entity = { id: 't', type: 'polygon', corners: [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)] };
    expect(pick(triangle, 100, 50)).toBe('t');
    expect(pick(triangle, 300, 250)).toBeNull();
    const concaveCorners = [v3(0, 0, 0), v3(400, 0, 0), v3(400, 100, 0), v3(100, 100, 0), v3(100, 300, 0), v3(0, 300, 0)];
    for (const winding of [concaveCorners, [...concaveCorners].reverse()]) {
      const concave: Entity = { id: 'c', type: 'polygon', corners: winding };
      expect(pick(concave, 250, 50)).toBe('c');
      expect(pick(concave, 50, 200)).toBe('c');
      expect(pick(concave, 250, 200)).toBeNull();
    }
  });

  it('picks the nearer cap of a signed-depth solid', () => {
    const projector = topViewProjector(1, 0, 0);
    const up: Entity = { id: 'up', type: 'extrusion', corners: [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)], depth: 200 };
    const down: Entity = { ...up, id: 'down', depth: -200 };
    expect(pickFace([up, down], v2(100, -50), projector)?.id).toBe('up');
    expect(pickFace([down, up], v2(100, -50), projector)?.id).toBe('up');
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
