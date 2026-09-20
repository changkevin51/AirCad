import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import type { EdgeGuide } from '../model/edge-inference';
import type { Viewport } from '../scene/viewport';
import { entityTriangles, makeRect, type Entity } from '../model/sketch';
import { v3 } from '../model/vec';
import { COLORS, SketchRenderer } from './sketch-renderer';

vi.mock('three/addons/renderers/CSS2DRenderer.js', async () => {
  const { Object3D } = await import('three');
  class CSS2DObject extends Object3D {
    constructor(readonly element: { className: string; textContent: string }) {
      super();
    }
  }
  class CSS2DRenderer {}
  return { CSS2DObject, CSS2DRenderer };
});

function stubDocument(): void {
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            beginPath() {},
            arc() {},
            fill() {},
            stroke() {},
          }),
        };
      }
      return { className: '', textContent: '' };
    },
  });
}

function makeViewport() {
  const resize: (() => void)[] = [];
  const raw = {
    scene: new THREE.Scene(),
    width: 800,
    height: 600,
    worldPerPixel: () => 1,
    onResize: (cb: () => void) => {
      resize.push(cb);
      return () => {};
    },
  };
  return { viewport: raw as unknown as Viewport, raw, resize };
}

function named(group: THREE.Group, name: string): THREE.Object3D {
  const object = group.getObjectByName(name);
  if (!object) throw new Error(`missing object ${name}`);
  return object;
}

const positions = (segments: LineSegments2): { start: number[]; end: number[]; count: number } => {
  const start = segments.geometry.getAttribute('instanceStart');
  const end = segments.geometry.getAttribute('instanceEnd');
  return {
    count: start.count,
    start: [start.getX(0), start.getY(0), start.getZ(0)],
    end: [end.getX(0), end.getY(0), end.getZ(0)],
  };
};

const segmentAt = (segments: LineSegments2, index: number): { start: number[]; end: number[] } => {
  const start = segments.geometry.getAttribute('instanceStart');
  const end = segments.geometry.getAttribute('instanceEnd');
  return {
    start: [start.getX(index), start.getY(index), start.getZ(index)],
    end: [end.getX(index), end.getY(index), end.getZ(index)],
  };
};

describe('edge guide visuals', () => {
  beforeEach(stubDocument);
  afterEach(() => vi.unstubAllGlobals());

  const baseGuide = (): EdgeGuide => ({
    reference: { entityId: 'ref', a: v3(0, 0, 0), b: v3(200, 0, 0), index: 0 },
    start: v3(0, 60, 0),
    end: v3(200, 60, 0),
    target: v3(200, 60, 0),
    targetLength: 200,
    matchedLength: false,
    normal: v3(0, 0, 1),
    distancePx: 60,
    angleDeg: 0,
  });

  it('shows guide geometry, ticks, reference and label, then hides cleanly', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    const lines = named(renderer.group, 'edge-guide') as LineSegments2;
    const reference = named(renderer.group, 'edge-reference') as LineSegments2;
    const label = named(renderer.group, 'edge-guide-label');
    expect(lines.visible).toBe(false);
    expect(reference.visible).toBe(false);
    expect(label.visible).toBe(false);

    const guide = baseGuide();
    renderer.setEdgeGuide(guide);
    expect(lines.visible).toBe(true);
    expect(reference.visible).toBe(true);
    expect(label.visible).toBe(true);

    expect(positions(lines).count).toBe(5);
    expect(positions(reference).count).toBe(1);
    expect(positions(reference).start).toEqual([0, 0, 0]);
    expect(positions(reference).end).toEqual([200, 0, 0]);

    expect(segmentAt(lines, 0).start).toEqual([0, 60, 0]);
    expect(segmentAt(lines, 0).end).toEqual([200, 60, 0]);
    expect(segmentAt(lines, 1).start).toEqual([0, 0, 0]);
    expect(segmentAt(lines, 1).end).toEqual([0, 60, 0]);
    expect(segmentAt(lines, 2).start).toEqual([200, 0, 0]);
    expect(segmentAt(lines, 2).end).toEqual([200, 60, 0]);
    expect(segmentAt(lines, 3).start).toEqual([0, 55, 0]);
    expect(segmentAt(lines, 3).end).toEqual([0, 65, 0]);
    expect(segmentAt(lines, 4).start).toEqual([200, 55, 0]);
    expect(segmentAt(lines, 4).end).toEqual([200, 65, 0]);

    const material = lines.material as { dashSize: number; gapSize: number };
    expect(material.dashSize).toBe(6);
    expect(material.gapSize).toBe(4);

    const element = (label as unknown as { element: { className: string; textContent: string } }).element;
    expect(element.className).toContain('dim-label--ghost');
    expect(element.textContent).toBe('Parallel · 200 mm suggested');
    expect(label.position.x).toBeCloseTo(200);
    expect(label.position.y).toBeCloseTo(70);

    renderer.setEdgeGuide(null);
    expect(lines.visible).toBe(false);
    expect(reference.visible).toBe(false);
    expect(label.visible).toBe(false);
  });

  it('labels an exact length match', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    const label = named(renderer.group, 'edge-guide-label');
    renderer.setEdgeGuide({ ...baseGuide(), matchedLength: true });
    const element = (label as unknown as { element: { textContent: string } }).element;
    expect(element.textContent).toBe('Equal length · 200 mm');
  });

  it('reuses geometry for an identical guide and disposes it on replace', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    const lines = named(renderer.group, 'edge-guide') as LineSegments2;
    const guide = baseGuide();
    renderer.setEdgeGuide(guide);
    const geometry = lines.geometry;
    renderer.setEdgeGuide(guide);
    expect(lines.geometry).toBe(geometry);

    const dispose = vi.spyOn(geometry, 'dispose');
    renderer.setEdgeGuide({ ...guide, target: v3(210, 60, 0), targetLength: 210 });
    expect(dispose).toHaveBeenCalled();
    expect(lines.geometry).not.toBe(geometry);
  });

  it('updates both guide material resolutions on resize', () => {
    const { viewport, raw, resize } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    raw.width = 1024;
    raw.height = 768;
    resize.forEach((cb) => cb());
    const lines = named(renderer.group, 'edge-guide') as LineSegments2;
    const reference = named(renderer.group, 'edge-reference') as LineSegments2;
    for (const material of [lines.material, reference.material] as { resolution: THREE.Vector2 }[]) {
      expect(material.resolution.x).toBe(1024);
      expect(material.resolution.y).toBe(768);
    }
  });
});

const lineEntity: Entity = { id: 'e1', type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) };
const rectEntity: Entity = {
  id: 'e2',
  type: 'rect',
  corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000),
};
const boxEntity: Entity = { id: 'e3', type: 'extrusion', corners: rectEntity.corners, depth: 2500 };
const negativeBox: Entity = { id: 'e4', type: 'extrusion', corners: rectEntity.corners, depth: -2500 };
const triangleEntity: Entity = {
  id: 'e5',
  type: 'triangle',
  corners: [v3(0, 0, 0), v3(4000, 0, 0), v3(2000, 0, 1500)],
};
const reversedTriangle: Entity = {
  id: 'e6',
  type: 'triangle',
  corners: [v3(0, 0, 0), v3(2000, 0, 1500), v3(4000, 0, 0)],
};
const concaveEntity: Entity = {
  id: 'e7',
  type: 'polygon',
  corners: [v3(0, 0, 0), v3(400, 0, 0), v3(400, 100, 0), v3(100, 100, 0), v3(100, 300, 0), v3(400, 300, 0), v3(400, 400, 0), v3(0, 400, 0)],
};
const prismEntity: Entity = { id: 'e8', type: 'prism', corners: triangleEntity.corners, depth: 3000 };
const circleEntity: Entity = { id: 'e9', type: 'circle', center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: 50 };

describe('display style and presentation batches', () => {
  beforeEach(stubDocument);
  afterEach(() => vi.unstubAllGlobals());

  it('keeps X-ray faces translucent without depth writes', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    renderer.setSketch([boxEntity]);
    const faces = named(renderer.group, 'committed-faces') as THREE.Mesh;
    const material = faces.material as THREE.MeshBasicMaterial;
    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(material.opacity).toBe(0.12);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    expect((named(renderer.group, 'vertex-markers') as THREE.Points).material).toMatchObject({ depthTest: false });
  });

  it('switches committed faces to an opaque Lambert material in Shaded', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    renderer.setSketch([boxEntity]);
    const faces = named(renderer.group, 'committed-faces') as THREE.Mesh;
    const xrayGeometry = faces.geometry;
    renderer.setDisplayStyle('shaded');
    const material = faces.material as THREE.MeshLambertMaterial;
    expect(material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(material.depthWrite).toBe(true);
    expect(material.depthTest).toBe(true);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.polygonOffset).toBe(true);
    expect(material.color.getHex()).toBe(0xbcc6d2);
    expect((named(renderer.group, 'vertex-markers') as THREE.Points).material).toMatchObject({ depthTest: true });
    expect(faces.geometry).toBe(xrayGeometry);
  });

  it('splits standalone wires from profile and solid outlines', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    renderer.setSketch([lineEntity, rectEntity, boxEntity]);
    const wires = named(renderer.group, 'committed-wires') as LineSegments2;
    const edges = named(renderer.group, 'committed-edges') as LineSegments2;
    expect(positions(wires).count).toBe(1);
    expect(positions(wires).start).toEqual([0, 0, 0]);
    expect(positions(wires).end).toEqual([4000, 0, 0]);
    expect(positions(edges).count).toBe(4 + 12);
    renderer.setDisplayStyle('shaded');
    expect((edges.material as { color: THREE.Color }).color.getHex()).toBe(0x4d5866);
    expect((wires.material as { color: THREE.Color }).color.getHex()).toBe(COLORS.line);
  });

  it('computes face normals on buffer replacement for every entity type', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    const entities: Entity[] = [rectEntity, boxEntity, negativeBox, triangleEntity, reversedTriangle, concaveEntity, prismEntity, circleEntity];
    renderer.setSketch(entities);
    const faces = named(renderer.group, 'committed-faces') as THREE.Mesh;
    const normals = faces.geometry.getAttribute('normal');
    const positionsAttr = faces.geometry.getAttribute('position');
    expect(normals).toBeTruthy();
    expect(normals.count).toBe(positionsAttr.count);
    expect(positionsAttr.count).toBeGreaterThan(0);
    for (let index = 0; index < normals.count * normals.itemSize; index++) {
      expect(Number.isFinite(normals.array[index])).toBe(true);
    }
  });

  it('bakes face positions straight from entityTriangles for signed, reversed and concave entities', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    const entities: Entity[] = [negativeBox, reversedTriangle, concaveEntity, prismEntity];
    renderer.setSketch(entities);
    const faces = named(renderer.group, 'committed-faces') as THREE.Mesh;
    const expected = entities.flatMap((entity) =>
      entityTriangles(entity).flatMap((triangle) => triangle.flatMap((p) => [p.x, p.y, p.z])),
    );
    expect(Array.from(faces.geometry.getAttribute('position').array as Float32Array)).toEqual(expected);
  });

  it('does not rebuild committed geometry when toggling style or Reveal', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    renderer.setSketch([lineEntity, boxEntity]);
    const faces = named(renderer.group, 'committed-faces') as THREE.Mesh;
    const edges = named(renderer.group, 'committed-edges') as LineSegments2;
    const wires = named(renderer.group, 'committed-wires') as LineSegments2;
    const faceGeo = faces.geometry;
    const edgeGeo = edges.geometry;
    const wireGeo = wires.geometry;
    renderer.setDisplayStyle('shaded');
    renderer.setPresentation(true);
    renderer.setDisplayStyle('xray');
    renderer.setPresentation(false);
    expect(faces.geometry).toBe(faceGeo);
    expect(edges.geometry).toBe(edgeGeo);
    expect(wires.geometry).toBe(wireGeo);
  });

  it('hides the overlay group during presentation even if setters run', () => {
    const { viewport } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    renderer.setSketch([rectEntity]);
    const overlays = named(renderer.group, 'sketch-overlays');
    expect(overlays.visible).toBe(true);
    renderer.setPresentation(true);
    expect(overlays.visible).toBe(false);
    renderer.setHover(rectEntity);
    renderer.setSelected(rectEntity);
    renderer.setInk([v3(0, 0, 0), v3(10, 0, 0)]);
    renderer.setGhost([v3(0, 0, 0), v3(10, 0, 0), v3(10, 10, 0)], false, null);
    expect(overlays.visible).toBe(false);
    expect(named(renderer.group, 'committed-faces').visible).toBe(true);
    renderer.setPresentation(false);
    expect(overlays.visible).toBe(true);
  });

  it('updates wire material resolution and disposes replaced geometries', () => {
    const { viewport, raw, resize } = makeViewport();
    const renderer = new SketchRenderer(viewport);
    renderer.setSketch([lineEntity, rectEntity]);
    const wires = named(renderer.group, 'committed-wires') as LineSegments2;
    const faces = named(renderer.group, 'committed-faces') as THREE.Mesh;
    const firstWire = wires.geometry;
    const firstFaces = faces.geometry;
    const disposeWire = vi.spyOn(firstWire, 'dispose');
    const disposeFaces = vi.spyOn(firstFaces, 'dispose');
    renderer.setSketch([lineEntity]);
    expect(disposeWire).toHaveBeenCalled();
    expect(disposeFaces).toHaveBeenCalled();
    raw.width = 1280;
    raw.height = 720;
    resize.forEach((cb) => cb());
    expect((wires.material as { resolution: THREE.Vector2 }).resolution.x).toBe(1280);
    expect((wires.material as { resolution: THREE.Vector2 }).resolution.y).toBe(720);
  });
});
