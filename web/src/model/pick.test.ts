import { describe, expect, it } from 'vitest';
import { pickFace } from './pick';
import { makeRect, type RectEntity, type ExtrusionEntity } from './sketch';
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
});
