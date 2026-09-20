import { describe, expect, it } from 'vitest';
import { ExtrusionSession } from './extrusion';
import { defaultFaceIndex, labelForNormal, pickExtrusionTarget, pickProfileFace, profileFaces, pushPull } from './faces';
import { entityCenter, extrusionNormal, isTriangleProfile, makeRect, type ExtrusionEntity, type PrismEntity, type RectEntity, type TriangleEntity } from './sketch';
import type { Projector } from './snap';
import { frontViewProjector, topViewProjector } from './test-helpers';
import { dot, normalize, scale, sub, v2, v3, type Vec2, type Vec3 } from './vec';

const rect: RectEntity = { id: 'r', type: 'rect', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300) };
const solid: ExtrusionEntity = { ...rect, id: 's', type: 'extrusion', depth: 300 };

describe('profileFaces', () => {
  it('returns the two coincident sides of a flat rectangle, +n first', () => {
    const faces = profileFaces(rect);
    expect(faces).toHaveLength(2);
    expect(faces[0].normal).toEqual(v3(0, 0, 1));
    expect(faces[1].normal.z).toBe(-1);
    expect(Math.hypot(faces[1].normal.x, faces[1].normal.y)).toBe(0);
    expect(faces[0].axis).toBe('n');
    expect(faces.map((face) => face.sign)).toEqual([1, -1]);
    expect(faces[0].quad).toEqual(rect.corners);
    expect(faces[1].quad).toEqual(rect.corners);
    expect(faces[0].label).toBe('top');
    expect(faces[1].label).toBe('bottom');
  });

  it('returns six outward faces for a solid, one per direction', () => {
    const faces = profileFaces(solid);
    expect(faces).toHaveLength(6);
    const labels = faces.map((face) => face.label).sort();
    expect(labels).toEqual(['back', 'bottom', 'front', 'left', 'right', 'top']);
    const center = entityCenter(solid);
    for (const face of faces) {
      expect(dot(face.normal, sub(face.center, center))).toBeGreaterThan(0);
    }
    // Canonical order: +n, -n, +u, -u, +v, -v so indices are stable.
    expect(faces.map((face) => `${face.axis}${face.sign}`)).toEqual(['n1', 'n-1', 'u1', 'u-1', 'v1', 'v-1']);
  });
});

describe('defaultFaceIndex', () => {
  it('picks the face pointing at the camera', () => {
    const faces = profileFaces(solid);
    expect(faces[defaultFaceIndex(faces, v3(0, 0, -1))].label).toBe('top');
    expect(faces[defaultFaceIndex(faces, v3(0, 0, 1))].label).toBe('bottom');
  });

  it('picks a visible face from the isometric view', () => {
    const faces = profileFaces(solid);
    // Orbit 'iso' sits at (1,-1,1), so the camera looks along (-1,1,-1).
    const view = normalize(v3(-1, 1, -1));
    const face = faces[defaultFaceIndex(faces, view)];
    expect(dot(face.normal, scale(view, -1))).toBeGreaterThan(0);
    expect(face.label).toBe('top');
  });
});

describe('pickProfileFace', () => {
  it('picks the camera-facing side of a flat rectangle', () => {
    const faces = profileFaces(rect);
    const projector = topViewProjector();
    expect(pickProfileFace(faces, v2(420, 285), projector)).toBe(0);
    expect(pickProfileFace(faces, v2(450, 285), projector)).toBeNull();
  });

  it('picks the nearest solid face under the cursor', () => {
    const faces = profileFaces(solid);
    expect(pickProfileFace(faces, v2(420, 285), topViewProjector())).toBe(0);
  });
});

describe('pushPull', () => {
  const faces = () => profileFaces(rect);
  const solidFaces = () => profileFaces(solid);

  it('pulls a rectangle along its normal without moving the corners', () => {
    expect(pushPull(rect, faces()[0], 250, 10)).toEqual({ corners: rect.corners, depth: 250 });
    expect(pushPull(rect, faces()[1], 250, 10)).toEqual({ corners: rect.corners, depth: -250 });
    // A flat profile can cross zero: no clamp on the n axis.
    expect(pushPull(rect, faces()[0], -100, 10).depth).toBe(-100);
  });

  it('pulls the far cap of a solid by changing only the depth', () => {
    const result = pushPull(solid, solidFaces()[0], 100, 10);
    expect(result.depth).toBe(400);
    expect(result.corners).toEqual(solid.corners);
  });

  it('pulls the base cap of a solid by moving the origin', () => {
    const result = pushPull(solid, solidFaces()[1], 100, 10);
    expect(result.depth).toBe(400);
    expect(result.corners[0]).toEqual(v3(0, 0, -100));
    expect(result.corners[3]).toEqual(v3(0, 300, -100));
  });

  it('widens the box when a +u side is pulled, keeps the origin when -u clamps', () => {
    const grown = pushPull(solid, solidFaces()[2], 50, 10);
    expect(grown.corners[1]).toEqual(v3(450, 0, 0));
    expect(grown.corners[0]).toEqual(v3(0, 0, 0));
    expect(grown.depth).toBe(300);

    const shifted = pushPull(solid, solidFaces()[3], 50, 10);
    expect(shifted.corners[0]).toEqual(v3(-50, 0, 0));
    expect(shifted.corners[1]).toEqual(v3(400, 0, 0));
  });

  it('clamps a side pushed past minSize without moving the opposite edge', () => {
    const result = pushPull(solid, solidFaces()[3], -1000, 10);
    expect(result.corners[0]).toEqual(v3(390, 0, 0));
    expect(result.corners[1]).toEqual(v3(400, 0, 0));
    expect(result.corners[2]).toEqual(v3(400, 300, 0));
  });

  it('clamps a solid cap pushed through itself to minSize with the sign kept', () => {
    expect(pushPull(solid, solidFaces()[0], -1000, 10).depth).toBe(10);
    const base = pushPull(solid, solidFaces()[1], -1000, 10);
    expect(base.depth).toBe(10);
    expect(base.corners[0]).toEqual(v3(0, 0, 290));
  });
});

describe('ExtrusionSession faces', () => {
  const UP = v2(0, -1);

  it('pulls the default +n face of a rect like before', () => {
    const session = new ExtrusionSession(rect, 10, 100, 0);
    expect(session.face.label).toBe('top');
    session.update(v2(100, 200), true, 'mouse', UP);
    session.update(v2(500, 146), true, 'mouse', UP);
    expect(session.depth).toBe(500);
    expect(session.pulled).toBe(500);
    expect(session.preview.corners).toEqual(rect.corners);
  });

  it('refuses to switch faces while dragging and wraps on cycle', () => {
    const session = new ExtrusionSession(rect, 10, 100, 0);
    session.update(v2(0, 300), true, 'mouse', UP);
    expect(session.dragging).toBe(true);
    expect(session.setFace(1)).toBe(false);
    expect(session.cycleFace()).toBe(false);
    session.update(v2(0, 300), false, 'mouse', UP);
    expect(session.cycleFace()).toBe(true);
    expect(session.faceIndex).toBe(1);
    expect(session.face.label).toBe('bottom');
    expect(session.cycleFace()).toBe(true);
    expect(session.faceIndex).toBe(0);
  });

  it('keeps depth while a side face is dragged after setFace', () => {
    const session = new ExtrusionSession(solid, 10, 100, 0);
    expect(session.setFace(2)).toBe(true);
    expect(session.face.label).toBe('right');
    session.update(v2(0, 300), true, 'mouse', UP);
    session.update(v2(0, 250), true, 'mouse', UP);
    expect(session.depth).toBe(300);
    expect(session.corners[1]).toEqual(v3(900, 0, 0));
    expect(session.pulled).toBe(500);
  });

  it('sets an exact pull distance with setPull', () => {
    const session = new ExtrusionSession(rect, 10, 100, 0);
    session.setPull(250);
    expect(session.depth).toBe(250);
    expect(session.pulled).toBe(250);
    session.setPull(-80);
    expect(session.depth).toBe(-80);
  });

  it.each([0, 1])('unlocks every new side after releasing the first pull from cap %s', (cap) => {
    const session = new ExtrusionSession(rect, 1, 0, cap);
    const faces = session.faces;
    expect(faces).toHaveLength(2);
    session.update(v2(100, 200), true, 'hand:1', UP);
    session.update(v2(100, 100), true, 'hand:1', UP);
    const depth = cap === 0 ? 100 : -100;
    expect(session.depth).toBe(depth);
    expect(session.faces).toBe(faces);
    expect(faces).toHaveLength(6);
    expect(faces).toEqual(session.currentFaces());
    expect(session.faceIndex).toBe(cap);
    expect(session.setFace(2)).toBe(false);
    expect(session.cycleFace()).toBe(false);
    session.update(v2(100, 100), false, 'hand:1', UP);

    for (const index of [2, 3, 4, 5]) {
      const before = structuredClone(session.preview);
      expect(session.setFace(index)).toBe(true);
      expect(session.faceIndex).toBe(index);
      expect(session.pulled).toBe(0);
      expect(session.preview).toEqual(before);
      session.update(v2(800, 600), true, 'hand:1', UP);
      expect(session.preview).toEqual(before);
      session.update(v2(800, 580), true, 'hand:1', UP);
      session.update(v2(800, 580), false, 'hand:1', UP);
      expect(session.depth).toBe(depth);
      expect(session.faces).toEqual(session.currentFaces());
    }
    expect(session.corners).toEqual([v3(-20, -20, 0), v3(420, -20, 0), v3(420, 320, 0), v3(-20, 320, 0)]);
    expect(rect.corners).toEqual([v3(0, 0, 0), v3(400, 0, 0), v3(400, 300, 0), v3(0, 300, 0)]);
  });

  it.each([100, -100])('cycles through all six faces as soon as exact depth is %s', (depth) => {
    const session = new ExtrusionSession(rect, 1, 0, 0);
    session.setPull(depth);
    const preview = structuredClone(session.preview);
    for (const index of [1, 2, 3, 4, 5, 0]) {
      expect(session.cycleFace()).toBe(true);
      expect(session.faceIndex).toBe(index);
      expect(session.face).toEqual(session.currentFaces()[index]);
      expect(session.preview).toEqual(preview);
    }
  });

  it('drops vanished sides when depth returns to zero and restores them when it grows again', () => {
    const session = new ExtrusionSession(rect, 1, 0, 0);
    session.setPull(100);
    expect(session.setFace(2)).toBe(true);
    session.setDepth(0);
    expect(session.faces).toHaveLength(2);
    expect(session.faceIndex).toBe(0);
    expect(session.face).toEqual(session.currentFaces()[0]);
    expect(session.setFace(2)).toBe(false);
    expect(session.cycleFace()).toBe(true);
    expect(session.faceIndex).toBe(1);
    expect(session.cycleFace()).toBe(true);
    expect(session.faceIndex).toBe(0);
    session.setDepth(-100);
    expect(session.faces).toHaveLength(6);
    expect(session.setFace(5)).toBe(true);
    expect(session.face).toEqual(session.currentFaces()[5]);
  });

  it('keeps circular extrusion limited to its two caps', () => {
    const session = new ExtrusionSession({ id: 'circle', type: 'circle', center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: 50 }, 1, 0, 0);
    session.setPull(100);
    expect(session.faces).toHaveLength(2);
    expect(session.setFace(2)).toBe(false);
    expect(session.cycleFace()).toBe(true);
    expect(session.faceIndex).toBe(1);
    expect(session.cycleFace()).toBe(true);
    expect(session.faceIndex).toBe(0);
  });
});

describe('labelForNormal', () => {
  it('maps the dominant world axis to a CAD label', () => {
    expect(labelForNormal(v3(0, 0, 1))).toBe('top');
    expect(labelForNormal(v3(0, 0, -1))).toBe('bottom');
    expect(labelForNormal(v3(0, -1, 0))).toBe('front');
    expect(labelForNormal(v3(0, 1, 0))).toBe('back');
    expect(labelForNormal(v3(1, 0, 0))).toBe('right');
    expect(labelForNormal(v3(-1, 0, 0))).toBe('left');
  });
});

describe('pickExtrusionTarget', () => {
  const top: Projector = {
    project: (point: Vec3): Vec2 => v2(point.x, point.y),
    ray: (point: Vec2) => ({ origin: v3(point.x, point.y, 1000), dir: v3(0, 0, -1) }),
  };
  const oblique: Projector = {
    project: (point: Vec3): Vec2 => v2(point.x - point.z, point.y),
    ray: (point: Vec2) => ({ origin: v3(point.x + 1000, point.y, 1000), dir: v3(-Math.SQRT1_2, 0, -Math.SQRT1_2) }),
  };

  it('picks the nearest shape and its exact face regardless of entity order', () => {
    const near: RectEntity = { ...rect, id: 'near', corners: rect.corners.map((point) => ({ ...point, z: 100 })) as RectEntity['corners'] };
    for (const entities of [[rect, near], [near, rect]]) {
      expect(pickExtrusionTarget(entities, v2(200, 150), top)).toEqual({ entity: near, faceIndex: 0 });
    }
    expect(pickExtrusionTarget([rect, solid], v2(250, 150), oblique)).toEqual({ entity: solid, faceIndex: 2 });
    expect(pickExtrusionTarget([rect], v2(900, 900), top)).toBeNull();
  });

  it('supports analytic circle and cylinder caps', () => {
    const circle = { id: 'c', type: 'circle' as const, center: v3(500, 150, 0), normal: v3(0, 0, 1), radius: 50 };
    const cylinder = { ...circle, id: 'cylinder', type: 'cylinder' as const, depth: 200 };
    expect(pickExtrusionTarget([rect, circle], v2(500, 150), top)).toEqual({ entity: circle, faceIndex: 0 });
    expect(pickExtrusionTarget([rect, cylinder], v2(500, 150), top)).toEqual({ entity: cylinder, faceIndex: 0 });
  });

  it('does not select a hidden cap or shape through a curved cylinder side', () => {
    const cylinder = { id: 'c', type: 'cylinder' as const, center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: 100, depth: 200 };
    const behind: RectEntity = { id: 'behind', type: 'rect', corners: makeRect(v3(-50, -50, -100), v3(1, 0, 0), v3(0, 1, 0), 100, 100) };
    for (const entities of [[cylinder, behind], [behind, cylinder]]) {
      expect(pickExtrusionTarget(entities, v2(0, 0), oblique)).toBeNull();
    }
  });
});

describe('triangular profiles', () => {
  const tri = (): TriangleEntity => ({ id: 't', type: 'triangle', corners: [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)] });
  const prism = (depth: number): PrismEntity => ({ id: 'p', type: 'prism', corners: tri().corners, depth });

  it('points the extrusion normal along the positive dominant axis for either winding', () => {
    const cases: [TriangleEntity['corners'], Vec3][] = [
      [[v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)], v3(0, 0, 1)],
      [[v3(0, 0, 0), v3(300, 0, 0), v3(0, 0, 300)], v3(0, 1, 0)],
      [[v3(0, 0, 0), v3(0, 300, 0), v3(0, 0, 300)], v3(1, 0, 0)],
    ];
    for (const [corners, expected] of cases) {
      for (const wound of [corners, [corners[0], corners[2], corners[1]]] as TriangleEntity['corners'][]) {
        const actual = extrusionNormal({ id: 't', type: 'triangle', corners: wound });
        expect(actual.x).toBeCloseTo(expected.x);
        expect(actual.y).toBeCloseTo(expected.y);
        expect(actual.z).toBeCloseTo(expected.z);
      }
    }
  });

  it('returns two coincident triangular caps for a flat triangle, never a fake quad', () => {
    const faces = profileFaces(tri());
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face.outline).toHaveLength(3);
      expect(face.axis).toBe('n');
      expect(face.quad).toBeUndefined();
      expect(face.edgeIndex).toBeUndefined();
    }
    expect(faces[0].normal.z).toBeCloseTo(1);
    expect(faces[1].normal.z).toBeCloseTo(-1);
    for (let index = 0; index < 3; index++) expect(faces[0].outline[index]).toEqual(faces[1].outline[index]);
  });

  it.each([100, -100])('returns five outward faces with three distinct sides for depth %s', (depth) => {
    const solid = prism(depth);
    const faces = profileFaces(solid);
    expect(faces).toHaveLength(5);
    const center = entityCenter(solid);
    for (const face of faces) {
      expect(dot(face.normal, sub(face.center, center))).toBeGreaterThan(0);
    }
    const caps = faces.filter((face) => face.axis === 'n');
    expect(caps.map((face) => face.sign)).toEqual([1, -1]);
    for (const cap of caps) expect(cap.outline).toHaveLength(3);
    const sides = faces.filter((face) => face.axis === 'edge');
    expect(sides.map((face) => face.edgeIndex).sort()).toEqual([0, 1, 2]);
    for (const side of sides) expect(side.quad).toHaveLength(4);
    for (const cap of caps) {
      const z = cap.sign === 1 ? Math.max(0, depth) : Math.min(0, depth);
      expect(cap.outline.every((point) => Math.abs(point.z - z) < 1e-9)).toBe(true);
    }
  });

  it('pulls flat triangle caps to signed depths with the corners fixed', () => {
    const flat = tri();
    const faces = profileFaces(flat);
    expect(pushPull(flat, faces[0], 250, 10)).toEqual({ corners: flat.corners, depth: 250 });
    expect(pushPull(flat, faces[1], 250, 10)).toEqual({ corners: flat.corners, depth: -250 });
    expect(pushPull(flat, faces[0], -100, 10).depth).toBe(-100);
  });

  it.each([100, -100])('pulls prism caps by editing signed depth for depth %s', (depth) => {
    const solid = prism(depth);
    const faces = profileFaces(solid);
    const positive = faces.find((face) => face.axis === 'n' && face.sign === 1)!;
    const negative = faces.find((face) => face.axis === 'n' && face.sign === -1)!;
    const outward = depth > 0 ? positive : negative;
    const inward = depth > 0 ? negative : positive;
    const far = pushPull(solid, outward, 50, 10);
    expect(far.depth).toBe(depth + Math.sign(depth) * 50);
    expect(far.corners).toEqual(solid.corners);
    const near = pushPull(solid, inward, 50, 10);
    expect(near.depth).toBe(depth + Math.sign(depth) * 50);
    for (let index = 0; index < 3; index++) {
      expect(near.corners[index].x).toBeCloseTo(solid.corners[index].x);
      expect(near.corners[index].y).toBeCloseTo(solid.corners[index].y);
      expect(near.corners[index].z).toBeCloseTo(solid.corners[index].z - Math.sign(depth) * 50);
    }
    expect(isTriangleProfile(near.corners)).toBe(true);
    expect(solid.corners[0].z).toBe(0);
  });

  it('clamps a prism cap pushed through itself without collapsing', () => {
    const solid = prism(100);
    const faces = profileFaces(solid);
    expect(pushPull(solid, faces[0], -1000, 10).depth).toBe(10);
    const base = pushPull(solid, faces[1], -1000, 10);
    expect(base.depth).toBe(10);
    expect(base.corners[0].z).toBeCloseTo(90);
    expect(isTriangleProfile(base.corners)).toBe(true);
  });

  it('pulls a prism side outward while keeping the opposite vertex fixed', () => {
    const solid = prism(100);
    const side = profileFaces(solid).find((face) => face.edgeIndex === 0)!;
    const result = pushPull(solid, side, 100, 10);
    expect(result.depth).toBe(100);
    expect(result.corners[0].x).toBeCloseTo(0);
    expect(result.corners[0].y).toBeCloseTo(-100);
    expect(result.corners[1].x).toBeCloseTo(400);
    expect(result.corners[1].y).toBeCloseTo(-100);
    expect(result.corners[2]).toEqual(v3(0, 300, 0));
    expect(solid.corners[0]).toEqual(v3(0, 0, 0));
    expect(solid.corners[1]).toEqual(v3(300, 0, 0));
    expect(isTriangleProfile(result.corners)).toBe(true);
  });

  it('clamps a side pushed past collapse to minSize', () => {
    const solid = prism(100);
    const side = profileFaces(solid).find((face) => face.edgeIndex === 0)!;
    const result = pushPull(solid, side, -1000, 10);
    expect(result.depth).toBe(100);
    expect(result.corners[2]).toEqual(v3(0, 300, 0));
    expect(result.corners[0].y).toBeCloseTo(290);
    expect(result.corners[1].x).toBeCloseTo(10);
    expect(result.corners[1].y).toBeCloseTo(290);
    expect(isTriangleProfile(result.corners)).toBe(true);
  });

  it('picks a triangle cap and prism side faces without assuming quads', () => {
    const top = topViewProjector(1, 0, 0);
    const triangle = tri();
    expect(pickProfileFace(profileFaces(triangle), v2(50, -50), top)).toBe(0);
    expect(pickExtrusionTarget([triangle], v2(50, -50), top)).toEqual({ entity: triangle, faceIndex: 0 });
    expect(pickExtrusionTarget([triangle], v2(250, -250), top)).toBeNull();

    const solid = prism(100);
    expect(pickExtrusionTarget([solid], v2(50, -50), top)).toEqual({ entity: solid, faceIndex: 0 });
    const front = frontViewProjector(1, 0, 0);
    const sidePick = pickExtrusionTarget([solid], v2(150, -50), front);
    expect(sidePick?.entity).toBe(solid);
    expect(sidePick?.faceIndex).toBe(2);
    expect(profileFaces(solid)[2].edgeIndex).toBe(0);
  });
});
