import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { AirCadApi } from './main';
import { adaptiveGridStep } from './model/snap';
import { makeRect } from './model/sketch';
import { v2, v3, type Vec2, type Vec3 } from './model/vec';
import type { HandsMessage, TrackedHandMessage } from './input/tracker-client';

const state = vi.hoisted(() => ({
  renderer: null as any,
  hud: null as any,
  help: null as any,
  measure: null as any,
  mouse: null as any,
  tracker: null as any,
  viewport: null as any,
  planeVisual: null as any,
  toasts: [] as string[],
  resolveCalls: 0,
  rafCb: null as ((time: number) => void) | null,
  windowListeners: {} as Record<string, ((event: Record<string, unknown>) => void)[]>,
}));

vi.mock('./scene/viewport', async () => {
  const { v2, v3 } = await import('./model/vec');
  const raycaster = new THREE.Raycaster();
  const scratch = new THREE.Vector3();
  class MockViewport {
    readonly scene = new THREE.Scene();
    readonly perspective = new THREE.PerspectiveCamera(45, 800 / 600, 10, 1e6);
    readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    ortho = false;
    width = 800;
    height = 600;
    private readonly resizeListeners = new Set<() => void>();
    constructor(readonly container: unknown) {
      state.viewport = this;
      this.perspective.up.set(0, 0, 1);
      this.orthographic.up.set(0, 0, 1);
    }
    get camera() {
      return this.ortho ? this.orthographic : this.perspective;
    }
    get aspect() {
      return this.width / Math.max(1, this.height);
    }
    onResize(listener: () => void) {
      this.resizeListeners.add(listener);
      return () => this.resizeListeners.delete(listener);
    }
    resize() {}
    render() {}
    viewDirection() {
      const d = this.camera.getWorldDirection(new THREE.Vector3());
      return v3(d.x, d.y, d.z);
    }
    project(world: Vec3): Vec2 | null {
      const camera = this.syncCamera();
      const point = scratch.set(world.x, world.y, world.z);
      point.applyMatrix4(camera.matrixWorldInverse);
      if (!this.ortho && point.z > -1e-6) return null;
      point.applyMatrix4(camera.projectionMatrix);
      return v2(((point.x + 1) / 2) * this.width, ((1 - point.y) / 2) * this.height);
    }
    ray(screen: Vec2) {
      const camera = this.syncCamera();
      const ndc = new THREE.Vector2((screen.x / this.width) * 2 - 1, -(screen.y / this.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const { origin, direction } = raycaster.ray;
      return { origin: v3(origin.x, origin.y, origin.z), dir: v3(direction.x, direction.y, direction.z) };
    }
    projector() {
      this.syncCamera();
      return {
        project: (world: Vec3) => this.project(world),
        ray: (screen: Vec2) => this.ray(screen),
      };
    }
    private syncCamera() {
      const camera = this.camera;
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      return camera;
    }
  }
  return { Viewport: MockViewport, CAMERA_FOV_DEG: 45 };
});

vi.mock('./scene/grid', () => {
  class AxisTriad {
    render() {}
  }
  return { AxisTriad, createGroundGrid: () => new THREE.Group() };
});

vi.mock('./scene/workplane-visual', () => {
  class WorkPlaneVisual {
    readonly group = new THREE.Group();
    last: { plane: { kind: string; offset: number }; step: number } | null = null;
    constructor() {
      state.planeVisual = this;
    }
    update(plane: { kind: string; offset: number }, step: number) {
      this.last = { plane, step };
    }
  }
  return { WorkPlaneVisual };
});

vi.mock('./render/sketch-renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render/sketch-renderer')>();
  class MockRenderer {
    sketch: unknown = null;
    hovered: unknown = null;
    lastLabel: unknown = null;
    ink: unknown = null;
    ghost: { points: Vec3[]; closed: boolean; label: { text: string; at: Vec3 } | null } | null = null;
    constructor() {
      state.renderer = this;
    }
    setSketch(entities: unknown) {
      this.sketch = entities;
    }
    setHover(entity: unknown) {
      this.hovered = entity;
    }
    setLastLabel(entity: unknown) {
      this.lastLabel = entity;
    }
    setInk(points: unknown) {
      this.ink = points;
    }
    setGhost(points: Vec3[] | null, closed: boolean, label: { text: string; at: Vec3 } | null) {
      this.ghost = points ? { points, closed, label } : null;
    }
    fadeOut() {}
    tick() {}
  }
  return { ...actual, SketchRenderer: MockRenderer };
});

vi.mock('./ui/hud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/hud')>();
  class MockHud {
    last: Record<string, unknown> | null = null;
    keys: unknown = null;
    constructor() {
      state.hud = this;
    }
    update(next: Record<string, unknown>) {
      this.last = next;
    }
    setKeys(keys: unknown) {
      this.keys = keys;
    }
  }
  return { ...actual, Hud: MockHud };
});

vi.mock('./ui/toast', () => {
  class Toasts {
    show(message: string) {
      state.toasts.push(message);
    }
  }
  return { Toasts };
});

vi.mock('./ui/help', () => {
  class HelpOverlay {
    visible = false;
    constructor() {
      state.help = this;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    toggle() {
      this.visible = !this.visible;
    }
  }
  return { HelpOverlay };
});

vi.mock('./ui/measure-input', () => {
  class MeasureInput {
    isOpen = false;
    constructor() {
      state.measure = this;
    }
    open() {
      this.isOpen = true;
    }
    close() {
      this.isOpen = false;
    }
  }
  return { MeasureInput };
});

vi.mock('./ui/pip', () => {
  class CameraPip {
    setThumb() {}
    setCameraState() {}
    setHands() {}
    toggle() {
      return false;
    }
  }
  return { CameraPip };
});

vi.mock('./ui/cursor-glyph', () => {
  class CursorGlyph {
    update() {}
  }
  return { CursorGlyph };
});

vi.mock('./input/tracker-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./input/tracker-client')>();
  class MockTracker {
    constructor(_url: string, handlers: unknown) {
      state.tracker = handlers;
    }
    connect() {}
    close() {}
  }
  return { ...actual, TrackerClient: MockTracker, defaultTrackerUrl: () => 'ws://test' };
});

vi.mock('./input/mouse-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./input/mouse-source')>();
  class MockMouse {
    constructor(_element: unknown, handlers: unknown) {
      state.mouse = handlers;
    }
    releaseAll() {}
    dispose() {}
  }
  return { ...actual, MouseSource: MockMouse };
});

vi.mock('./model/stroke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./model/stroke')>();
  const counted = (...args: Parameters<typeof actual.resolveStroke>) => {
    state.resolveCalls++;
    return actual.resolveStroke(...args);
  };
  return { ...actual, resolveStroke: counted };
});

class FakeElement {
  className = '';
  tabIndex = 0;
  readonly children: unknown[] = [];
  clientWidth = 800;
  clientHeight = 600;
  appendChild<T>(child: T): T {
    this.children.push(child);
    return child;
  }
  append(...children: unknown[]): void {
    this.children.push(...children);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  focus(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

let api: AirCadApi;
let frameTime = 0;
let gridOn = true;

function tick(dt = 16): void {
  frameTime += dt;
  state.rafCb?.(frameTime);
}

function finishTransitions(): void {
  tick(200);
}

function dispatchWindow(type: string, event: Record<string, unknown>): void {
  for (const listener of state.windowListeners[type] ?? []) listener(event);
}

const keyEvent = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  target: {},
  preventDefault() {},
  ...over,
});

function cameraDir(): Vec3 {
  const d = state.viewport.perspective.getWorldDirection(new THREE.Vector3());
  return v3(d.x, d.y, d.z);
}

function setCursorWorld(world: Vec3): void {
  const px = api.project(world);
  if (!px) throw new Error(`cannot project ${JSON.stringify(world)}`);
  api.setCursor(px);
}

function strokeThrough(worldPoints: Vec3[]): void {
  setCursorWorld(worldPoints[0]);
  api.hold('draw', true);
  for (const point of worldPoints.slice(1)) setCursorWorld(point);
  api.hold('draw', false);
}

function setGrid(on: boolean): void {
  if (gridOn !== on) {
    api.press('toggleGrid');
    gridOn = on;
  }
}

const handMessage = (nav: HandsMessage['nav'], over: Partial<TrackedHandMessage> = {}): HandsMessage => {
  const hand: TrackedHandMessage = {
    id: 1,
    handedness: 'right',
    tip: [320, 240],
    thumb: [300, 250],
    palm: [330, 300],
    palmSize: 80,
    pinching: false,
    open: false,
    openArmed: false,
    landmarks: [],
    ...over,
  };
  return { type: 'hands', t: 0, frame: { w: 640, h: 480 }, hands: [hand], nav };
};

const emptyHands = (): HandsMessage => ({ type: 'hands', t: 0, frame: { w: 640, h: 480 }, hands: [], nav: null });

beforeAll(async () => {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => new FakeElement(),
    getElementById: () => new FakeElement(),
  };
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
      (state.windowListeners[type] ??= []).push(listener);
    },
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    location: { protocol: 'http:', host: 'localhost' },
  };
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (time: number) => void) => {
    state.rafCb = cb;
    return 1;
  };
  await import('./main');
  api = (globalThis as { window: { aircad: AirCadApi } }).window.aircad;
});

beforeEach(() => {
  if (state.help) state.help.visible = false;
  if (state.measure) state.measure.isOpen = false;
  dispatchWindow('blur', {});
  state.tracker?.onConnection('closed');
  api.sketch.load({ version: 1, units: 'mm', entities: [] });
  api.press('clear');
  api.press('viewTop');
  finishTransitions();
  if (api.planeMode() === 'manual') api.press('toggleAutoPlane');
  setGrid(true);
  state.toasts.length = 0;
  state.resolveCalls = 0;
});

describe('app stroke flows', () => {
  it('completes a wall against a shared floor border in one undoable commit', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    api.press('viewRight');
    finishTransitions();
    setGrid(false);
    strokeThrough([
      v3(4000, 1500, 0),
      v3(4000, 1500, 1200),
      v3(4000, 1500, 2500),
      v3(4000, 2000, 2500),
      v3(4000, 2500, 2500),
      v3(4000, 2500, 1200),
      v3(4000, 2500, 0),
    ]);
    expect(api.lastRecognition()?.reason).toBe('shared-border rectangle');
    expect(api.sketch.size).toBe(2);
    const wall = api.sketch.all[1];
    expect(wall.type).toBe('rect');
    if (wall.type === 'rect') {
      const expected = [v3(4000, 1500, 0), v3(4000, 1500, 2500), v3(4000, 2500, 2500), v3(4000, 2500, 0)];
      for (const corner of wall.corners) {
        expect(expected.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y, point.z - corner.z) < 1e-3)).toBe(true);
      }
    }
    api.commands.undo();
    expect(api.sketch.size).toBe(1);
    expect(api.sketch.all[0].type).toBe('rect');
  });

  it('assembles separately drawn lines into a rectangle atomically', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    api.commands.addLine(v3(4000, 0, 0), v3(4000, 0, 2500));
    api.commands.addLine(v3(4000, 0, 2500), v3(4000, 3000, 2500));
    api.press('viewRight');
    finishTransitions();
    setGrid(false);
    strokeThrough([v3(4000, 3000, 2500), v3(4000, 3000, 1200), v3(4000, 3000, 0)]);
    expect(api.lastRecognition()?.reason).toBe('assembled rectangle');
    expect(api.sketch.size).toBe(2);
    expect(api.sketch.all.every((entity) => entity.type === 'rect')).toBe(true);
    api.commands.undo();
    expect(api.sketch.size).toBe(3);
    expect(api.sketch.all.filter((entity) => entity.type === 'line')).toHaveLength(2);
  });

  it('previews the eventual shared-border rectangle while drawing', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    api.press('viewRight');
    finishTransitions();
    setGrid(false);
    setCursorWorld(v3(4000, 1500, 0));
    api.hold('draw', true);
    for (const point of [v3(4000, 1500, 2500), v3(4000, 2000, 2500), v3(4000, 2500, 2500), v3(4000, 2500, 0)]) {
      setCursorWorld(point);
    }
    tick();
    const ghost = state.renderer.ghost;
    expect(ghost).not.toBeNull();
    expect(ghost.closed).toBe(true);
    expect(ghost.label?.text).toContain('shared border');
    api.hold('draw', false);
    const wall = api.sketch.all[1];
    expect(wall.type).toBe('rect');
    if (wall.type === 'rect') {
      for (const corner of wall.corners) {
        expect(ghost.points.some((point: Vec3) => Math.hypot(point.x - corner.x, point.y - corner.y, point.z - corner.z) < 1e-3)).toBe(true);
      }
    }
  });

  it('builds a wall from three separately drawn strokes and restores them on undo', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    api.press('viewRight');
    finishTransitions();
    setGrid(false);
    strokeThrough([v3(4000, 0, 0), v3(4000, 0, 1200), v3(4000, 0, 2500)]);
    expect(api.sketch.size).toBe(2);
    strokeThrough([v3(4000, 0, 2500), v3(4000, 1500, 2500), v3(4000, 3000, 2500)]);
    expect(api.sketch.size).toBe(3);
    strokeThrough([v3(4000, 3000, 2500), v3(4000, 3000, 1200), v3(4000, 3000, 0)]);
    expect(api.lastRecognition()?.reason).toBe('assembled rectangle');
    expect(api.sketch.size).toBe(2);
    expect(api.sketch.all.every((entity) => entity.type === 'rect')).toBe(true);
    api.commands.undo();
    expect(api.sketch.size).toBe(3);
    expect(api.sketch.all.filter((entity) => entity.type === 'line')).toHaveLength(2);
  });

  it('treats a repeated rectangle as a duplicate without history', () => {
    setGrid(false);
    const loop = [
      v3(0, 0, 0),
      v3(2000, 0, 0),
      v3(4000, 0, 0),
      v3(4000, 1500, 0),
      v3(4000, 3000, 0),
      v3(2000, 3000, 0),
      v3(0, 3000, 0),
      v3(0, 1500, 0),
      v3(0, 0, 0),
    ];
    strokeThrough(loop);
    expect(api.sketch.size).toBe(1);
    strokeThrough(loop);
    expect(api.sketch.size).toBe(1);
    expect(state.toasts.some((message) => message.includes('already exists'))).toBe(true);
    api.commands.undo();
    expect(api.sketch.size).toBe(0);
    expect(api.commands.undo()).toBeNull();
  });
});

describe('work plane modes', () => {
  it('defaults to auto, toggles with A, and pins with Tab or view keys', () => {
    expect(api.planeMode()).toBe('auto');
    api.press('toggleAutoPlane');
    expect(api.planeMode()).toBe('manual');
    api.press('toggleAutoPlane');
    expect(api.planeMode()).toBe('auto');
    api.press('cyclePlane');
    expect(api.planeMode()).toBe('manual');
    expect(api.plane().kind).toBe('XZ');
    api.press('viewTop');
    expect(api.plane().kind).toBe('XY');
    api.press('viewIso');
    finishTransitions();
    expect(api.planeMode()).toBe('manual');
    expect(api.plane().kind).toBe('XY');
  });

  it('lifts the plane onto a hovered face interior in auto mode', () => {
    api.commands.addRect(makeRect(v3(0, 0, 2500), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    setCursorWorld(v3(2000, 1500, 2500));
    tick(100);
    expect(api.plane().offset).toBeCloseTo(0, 5);
    tick(150);
    expect(api.plane().offset).toBeCloseTo(2500, 5);
    expect(api.plane().kind).toBe('XY');
    tick();
    expect(state.hud.last?.planeMode).toBe('Auto');
    expect(state.hud.last?.planeReason).toBe('hovered face');
  });

  it('uses the inferred plane for visuals in the same frame it switches', () => {
    api.commands.addRect(makeRect(v3(0, 0, 2500), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    const px = api.project(v3(2000, 1500, 2500))!;
    setCursorWorld(v3(2000, 1500, 2500));
    tick(100);
    tick(150);
    expect(api.plane().offset).toBeCloseTo(2500, 5);
    expect(state.planeVisual.last?.plane.offset).toBeCloseTo(2500, 5);
    expect((state.hud.last?.plane as { kind: string } | undefined)?.kind).toBe('XY');
    expect(state.hud.last?.gridStep).toBe(state.planeVisual.last?.step);
    const ray = api.ray(px);
    const hit = api.plane().intersectRay(ray.origin, ray.dir)!;
    const readyStep = adaptiveGridStep(state.viewport.projector(), api.plane(), hit, 8);
    expect(state.hud.last?.gridStep).toBe(readyStep);
    api.hold('draw', true);
    tick();
    expect(state.hud.last?.gridStep).toBe(readyStep);
    api.hold('draw', false);
  });

  it('shows the pinned reason while in manual mode', () => {
    api.press('toggleAutoPlane');
    tick();
    expect(state.hud.last?.planeMode).toBe('Manual');
    expect(state.hud.last?.planeReason).toBe('pinned');
  });
});

describe('stroke guards', () => {
  it('freezes view, projection, zoom and plane inputs while drawing', () => {
    api.press('viewRight');
    finishTransitions();
    const before = state.viewport.perspective.quaternion.clone();
    setCursorWorld(v3(4000, 1000, 500));
    api.hold('draw', true);
    const planeKind = api.plane().kind;
    api.press('viewTop');
    api.press('toggleProjection');
    api.press('zoomIn');
    api.press('cyclePlane');
    api.press('toggleAutoPlane');
    state.mouse.onWheel(1.4, v2(400, 300));
    tick();
    expect(state.viewport.perspective.quaternion.equals(before)).toBe(true);
    expect(state.viewport.ortho).toBe(false);
    expect(api.plane().kind).toBe(planeKind);
    expect(api.planeMode()).toBe('manual');
    api.hold('draw', false);
  });

  it('finishes a running preset transition when the pen goes down', () => {
    api.press('viewFront');
    tick(60);
    setCursorWorld(v3(1000, 0, 500));
    api.hold('draw', true);
    const d = cameraDir();
    expect(d.x).toBeCloseTo(0, 5);
    expect(d.y).toBeCloseTo(1, 5);
    expect(d.z).toBeCloseTo(0, 5);
    api.hold('draw', false);
  });

  it('adds no history when blur, pointer cancel, or help aborts a stroke', () => {
    setCursorWorld(v3(0, 0, 0));
    api.hold('draw', true);
    setCursorWorld(v3(2000, 0, 0));
    dispatchWindow('blur', {});
    expect(api.sketch.size).toBe(0);
    expect(state.renderer.ghost).toBeNull();

    api.hold('draw', true);
    setCursorWorld(v3(3000, 0, 0));
    state.mouse.onCancel();
    expect(api.sketch.size).toBe(0);

    api.hold('draw', true);
    setCursorWorld(v3(3000, 1000, 0));
    api.press('help');
    expect(state.help.visible).toBe(true);
    expect(api.sketch.size).toBe(0);
  });

  it('refuses a free start on an edge-on pinned plane but still allows object starts', () => {
    api.press('viewFront');
    finishTransitions();
    api.press('cyclePlane');
    expect(api.plane().kind).toBe('YZ');
    setCursorWorld(v3(0, 0, 1200));
    api.hold('draw', true);
    api.hold('draw', false);
    expect(api.sketch.size).toBe(0);
    expect(state.toasts.some((message) => message.includes('edge-on'))).toBe(true);

    api.commands.addLine(v3(0, 1000, 0), v3(0, 1000, 2500));
    strokeThrough([v3(0, 1000, 0), v3(0, 1500, 700), v3(0, 2000, 1250)]);
    expect(api.sketch.size).toBe(2);
    expect(api.sketch.all[1].type).toBe('line');
  });

  it('refuses a free start on a nearly edge-on pinned plane', () => {
    api.press('viewTop');
    finishTransitions();
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    api.setCursor(v2(400, 300));
    api.setCursor(v2(400, 541));
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
    api.setCursor(v2(400, 300));
    api.hold('draw', true);
    api.hold('draw', false);
    expect(api.sketch.size).toBe(0);
    expect(state.toasts.some((message) => message.includes('edge-on'))).toBe(true);
  });

  it('shows the frozen stroke grid step in the HUD and on the plane visual', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    api.press('viewRight');
    finishTransitions();
    setCursorWorld(v3(4000, 1500, 0));
    api.hold('draw', true);
    tick();
    const expected = adaptiveGridStep(state.viewport.projector(), api.plane(), v3(4000, 1500, 0), 8);
    expect(state.hud.last?.gridStep).toBe(expected);
    expect(state.planeVisual.last?.step).toBe(expected);
    tick();
    expect(state.hud.last?.gridStep).toBe(expected);
    api.hold('draw', false);
  });

  it('re-resolves the preview and commit when G toggles mid-stroke', () => {
    setGrid(true);
    const loop = [
      v3(130, 120, 0),
      v3(2070, 120, 0),
      v3(4070, 120, 0),
      v3(4070, 1660, 0),
      v3(4070, 3180, 0),
      v3(2070, 3180, 0),
      v3(130, 3180, 0),
      v3(130, 1660, 0),
      v3(130, 120, 0),
    ];
    setCursorWorld(loop[0]);
    api.hold('draw', true);
    for (const point of loop.slice(1)) setCursorWorld(point);
    tick();
    const roundedGhost = state.renderer.ghost;
    expect(roundedGhost).not.toBeNull();
    api.press('toggleGrid');
    gridOn = false;
    tick();
    const rawGhost = state.renderer.ghost;
    expect(rawGhost).not.toBeNull();
    const moved =
      roundedGhost!.points.length !== rawGhost!.points.length ||
      roundedGhost!.points.some(
        (point: Vec3, index: number) => Math.hypot(point.x - rawGhost!.points[index].x, point.y - rawGhost!.points[index].y) > 1,
      );
    expect(moved).toBe(true);
    api.hold('draw', false);
    const rect = api.sketch.all[0];
    expect(rect.type).toBe('rect');
    if (rect.type === 'rect') {
      for (const corner of rect.corners) {
        expect(rawGhost!.points.some((point: Vec3) => Math.hypot(point.x - corner.x, point.y - corner.y, point.z - corner.z) < 1e-3)).toBe(true);
      }
    }
  });

  it('refreshes the stroke endpoint when G toggles at a stationary cursor', () => {
    api.press('viewTop');
    finishTransitions();
    setCursorWorld(v3(0, 0, 0));
    api.hold('draw', true);
    setCursorWorld(v3(1234, 0, 0));
    tick();
    const rounded = state.renderer.ghost;
    expect(rounded).not.toBeNull();
    const roundedEnd = rounded!.points[rounded!.points.length - 1];
    expect(Math.abs(roundedEnd.x - 1234)).toBeGreaterThan(1);
    setGrid(false);
    tick();
    const unrounded = state.renderer.ghost;
    expect(unrounded).not.toBeNull();
    const end = unrounded!.points[unrounded!.points.length - 1];
    expect(end.x).toBeCloseTo(1234, 3);
    expect(end.y).toBeCloseTo(0, 3);
    expect(end.z).toBeCloseTo(0, 3);
    api.hold('draw', false);
    const line = api.sketch.all[api.sketch.size - 1];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.a.x).toBeCloseTo(0, 3);
      expect(line.b.x).toBeCloseTo(1234, 3);
      expect(line.b.y).toBeCloseTo(0, 3);
      expect(line.b.z).toBeCloseTo(0, 3);
    }
  });

  it('refreshes the stroke endpoint when an axis lock toggles at a stationary cursor', () => {
    api.press('viewTop');
    finishTransitions();
    setGrid(false);
    setCursorWorld(v3(0, 0, 0));
    api.hold('draw', true);
    setCursorWorld(v3(1234, 700, 0));
    tick();
    const free = state.renderer.ghost;
    expect(free!.points[free!.points.length - 1].y).toBeCloseTo(700, 3);
    api.hold('lockX', true);
    tick();
    const locked = state.renderer.ghost;
    expect(locked).not.toBeNull();
    const lockedEnd = locked!.points[locked!.points.length - 1];
    expect(lockedEnd.y).toBeCloseTo(0, 3);
    expect(lockedEnd.z).toBeCloseTo(0, 3);
    expect(Math.abs(lockedEnd.x - 1234)).toBeLessThan(10);
    api.hold('lockX', false);
    tick();
    const restored = state.renderer.ghost;
    expect(restored!.points[restored!.points.length - 1].y).toBeCloseTo(700, 3);
    api.hold('lockX', true);
    tick();
    api.hold('draw', false);
    api.hold('lockX', false);
    const line = api.sketch.all[api.sketch.size - 1];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.a.x).toBeCloseTo(0, 3);
      expect(line.a.y).toBeCloseTo(0, 3);
      expect(line.a.z).toBeCloseTo(0, 3);
      expect(line.b.x).toBeCloseTo(lockedEnd.x, 3);
      expect(line.b.y).toBeCloseTo(lockedEnd.y, 3);
      expect(line.b.z).toBeCloseTo(lockedEnd.z, 3);
    }
  });

  it('keeps the stroke alive while any hold source is still down', () => {
    setCursorWorld(v3(0, 0, 0));
    dispatchWindow('keydown', keyEvent('Space'));
    state.mouse.onHold('draw', true);
    dispatchWindow('keyup', keyEvent('Space'));
    tick();
    expect(state.hud.last?.mode).toBe('DRAWING');
    setCursorWorld(v3(4000, 0, 0));
    state.mouse.onHold('draw', false);
    expect(api.sketch.size).toBe(1);
    expect(api.sketch.all[0].type).toBe('line');
  });
});

describe('navigation gestures', () => {
  it('ignores palm navigation while an explicit orbit hold is active', () => {
    api.hold('orbit', true);
    const before = state.viewport.perspective.quaternion.clone();
    state.tracker.onHands(handMessage({ mode: 'one', pan: [40, 0], zoom: 1, rotation: 0 }));
    expect(state.viewport.perspective.quaternion.equals(before)).toBe(true);
    api.hold('orbit', false);
  });

  it('primes the cursor instead of jumping when a new hand takes over', () => {
    api.hold('orbit', true);
    const before = state.viewport.perspective.quaternion.clone();
    state.tracker.onHands(handMessage(null));
    const takeover = handMessage(null);
    takeover.hands[0].id = 7;
    takeover.hands[0].tip = [500, 100];
    state.tracker.onHands(takeover);
    expect(state.viewport.perspective.quaternion.equals(before)).toBe(true);
    api.hold('orbit', false);
  });

  it('does not settle a fresh takeover gesture on motion from the old one', () => {
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    state.tracker.onHands(handMessage(null));
    state.tracker.onHands(handMessage(null, { tip: [328, 240] }));
    const takeover = handMessage(null, { id: 7, tip: [500, 300] });
    state.tracker.onHands(takeover);
    state.tracker.onHands(handMessage(null, { id: 7, tip: [502, 300] }));
    const tilted = state.viewport.perspective.quaternion.clone();
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
    finishTransitions();
    expect(state.viewport.perspective.quaternion.equals(tilted)).toBe(true);
  });

  it('suspends a held orbit while drawing and resumes a fresh primed gesture', () => {
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    api.setCursor(v2(400, 300));
    api.setCursor(v2(408, 300));
    api.hold('draw', true);
    api.hold('draw', false);
    const primed = state.viewport.perspective.quaternion.clone();
    api.setCursor(v2(420, 300));
    expect(state.viewport.perspective.quaternion.equals(primed)).toBe(true);
    api.setCursor(v2(428, 300));
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
    finishTransitions();
    const d = cameraDir();
    expect(d.x).toBeCloseTo(0, 3);
    expect(d.y).toBeCloseTo(0, 3);
    expect(d.z).toBeCloseTo(-1, 3);
  });

  it('falls back from orbit to pan without settling and resumes a fresh orbit', () => {
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    api.setCursor(v2(400, 300));
    api.setCursor(v2(430, 300));
    const tilted = state.viewport.perspective.quaternion.clone();
    dispatchWindow('keydown', keyEvent('ControlLeft'));
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
    tick();
    expect(state.viewport.perspective.quaternion.equals(tilted)).toBe(true);
    api.setCursor(v2(430, 300));
    const position = state.viewport.perspective.position.clone();
    api.setCursor(v2(450, 300));
    expect(state.viewport.perspective.position.equals(position)).toBe(false);
    expect(state.viewport.perspective.quaternion.equals(tilted)).toBe(true);
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    dispatchWindow('keyup', keyEvent('ControlLeft'));
    api.setCursor(v2(470, 300));
    const primed = state.viewport.perspective.quaternion.clone();
    api.setCursor(v2(480, 300));
    expect(state.viewport.perspective.quaternion.equals(primed)).toBe(false);
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
  });

  it('blocks camera movement and new gestures under overlays', () => {
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    api.setCursor(v2(400, 300));
    api.setCursor(v2(430, 300));
    api.press('help');
    const q = state.viewport.perspective.quaternion.clone();
    api.setCursor(v2(500, 300));
    expect(state.viewport.perspective.quaternion.equals(q)).toBe(true);
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
    api.hold('orbit', true);
    api.setCursor(v2(550, 300));
    expect(state.viewport.perspective.quaternion.equals(q)).toBe(true);
    api.press('help');
    api.setCursor(v2(600, 300));
    expect(state.viewport.perspective.quaternion.equals(q)).toBe(true);
  });

  it('reacquires a held orbit after hand loss as a fresh primed gesture', () => {
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    state.tracker.onHands(handMessage(null));
    state.tracker.onHands(handMessage(null, { tip: [360, 240] }));
    const orbited = state.viewport.perspective.quaternion.clone();
    state.tracker.onHands(emptyHands());
    state.tracker.onHands(handMessage(null, { tip: [500, 300] }));
    expect(state.viewport.perspective.quaternion.equals(orbited)).toBe(true);
    state.tracker.onHands(handMessage(null, { tip: [560, 300] }));
    expect(state.viewport.perspective.quaternion.equals(orbited)).toBe(false);
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
  });

  it('keeps a mouse orbit continuous across empty hand frames', () => {
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    api.setCursor(v2(400, 300));
    api.setCursor(v2(430, 300));
    const q = state.viewport.perspective.quaternion.clone();
    state.tracker.onHands(emptyHands());
    api.setCursor(v2(460, 300));
    const angle = q.angleTo(state.viewport.perspective.quaternion);
    expect(angle).toBeGreaterThan(0.05);
    expect(angle).toBeLessThan(0.4);
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
  });

  it('clears palm navigation when a manual pan takes over', () => {
    api.press('toggleNavAssist');
    state.tracker.onHands(handMessage({ mode: 'one', pan: [5, 0], zoom: 1, rotation: 0 }));
    const tilted = state.viewport.perspective.quaternion.clone();
    dispatchWindow('keydown', keyEvent('ControlLeft'));
    state.tracker.onHands(handMessage({ mode: 'one', pan: [50, 0], zoom: 1, rotation: 0 }));
    expect(state.viewport.perspective.quaternion.equals(tilted)).toBe(true);
    dispatchWindow('keyup', keyEvent('ControlLeft'));
    api.press('toggleNavAssist');
  });

  it('keeps orbiting while a second Shift source is still held', () => {
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
    dispatchWindow('keydown', keyEvent('ShiftRight'));
    api.setCursor(v2(400, 300));
    api.setCursor(v2(430, 300));
    const q = state.viewport.perspective.quaternion.clone();
    dispatchWindow('keyup', keyEvent('ShiftLeft'));
    api.setCursor(v2(460, 300));
    expect(state.viewport.perspective.quaternion.equals(q)).toBe(false);
    dispatchWindow('keyup', keyEvent('ShiftRight'));
  });

  it('settles a palm orbit onto a nearby preset and skips settling after two palms', () => {
    api.press('toggleNavAssist');
    api.press('viewIso');
    finishTransitions();
    const iso = 1 / Math.sqrt(3);
    state.tracker.onHands(handMessage({ mode: 'one', pan: [0, 5], zoom: 1, rotation: 0 }));
    state.tracker.onHands(handMessage(null));
    finishTransitions();
    const d = cameraDir();
    expect(d.x).toBeCloseTo(-iso, 3);
    expect(d.y).toBeCloseTo(iso, 3);
    expect(d.z).toBeCloseTo(-iso, 3);

    const startEl = state.viewport.perspective.quaternion.clone();
    state.tracker.onHands(handMessage({ mode: 'one', pan: [0, 40], zoom: 1, rotation: 0 }));
    state.tracker.onHands(handMessage({ mode: 'two', pan: [0, 40], zoom: 1, rotation: 0 }));
    state.tracker.onHands(handMessage(null));
    tick();
    const d2 = cameraDir();
    expect(Math.abs(d2.z + iso)).toBeGreaterThan(0.01);
    expect(startEl.equals(state.viewport.perspective.quaternion)).toBe(false);
    api.press('toggleNavAssist');
  });
});

describe('stroke resolution caching', () => {
  it('does not re-resolve while the stroke, sketch and camera stay unchanged', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    setCursorWorld(v3(0, 0, 0));
    api.hold('draw', true);
    setCursorWorld(v3(2000, 0, 0));
    tick();
    const calls = state.resolveCalls;
    expect(calls).toBeGreaterThan(0);
    tick();
    tick();
    expect(state.resolveCalls).toBe(calls);
    setCursorWorld(v3(4000, 0, 0));
    tick();
    expect(state.resolveCalls).toBeGreaterThan(calls);
    api.hold('draw', false);
  });
});
