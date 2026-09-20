import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import type { EdgeGuide } from '../model/edge-inference';
import type { Viewport } from '../scene/viewport';
import { v3 } from '../model/vec';
import { SketchRenderer } from './sketch-renderer';

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
