import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { AirCadApi } from './main';
import type { HandsMessage, NavMessage, SpatialMessage, TrackedHandMessage } from './input/tracker-client';
import type { EdgeGuide } from './model/edge-inference';
import { adaptiveGridStep } from './model/snap';
import { makeRect, rectFrame, type ExtrusionEntity, type RectEntity } from './model/sketch';
import { add, distance, normalize, scale, sub, v2, v3, type Vec2, type Vec3 } from './model/vec';
import { OrbitController } from './scene/orbit';
import { EMPTY_PRESENTATION, PRESENTING_FIRST } from './ui/workspace-state';
import type { VoiceControlOptions } from './voice/control';

const state = vi.hoisted(() => ({
  renderer: null as any,
  shell: null as any,
  hud: null as any,
  help: null as any,
  measure: null as any,
  mouse: null as any,
  tracker: null as any,
  viewport: null as any,
  planeVisual: null as any,
  toasts: [] as string[],
  flashes: [] as string[],
  panel: null as any,
  panelHandlers: null as any,
  trackerClient: null as any,
  resolveCalls: 0,
  rafCb: null as ((time: number) => void) | null,
  windowListeners: {} as Record<string, ((event: Record<string, unknown>) => void)[]>,
  commands: null as any,
  voice: null as VoiceControlOptions | null,
  voiceControl: null as null | { toggle: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; busy: boolean },
  guide: vi.fn(),
  ghost: null as null | { points: Vec3[]; closed: boolean },
  glyph: { update: vi.fn() },
  orbit: { orbit: vi.fn(), pan: vi.fn(), zoom: vi.fn() },
  nowMs: 10_000,
  simpleProjector: false,
  projector: {
    project: (point: Vec3): Vec2 => ({ x: point.x, y: point.y - point.z }),
    ray: (point: Vec2): { origin: Vec3; dir: Vec3 } => ({
      origin: { x: point.x, y: point.y, z: 1000 },
      dir: { x: 0, y: 0, z: -1 },
    }),
    worldPerPixel: () => 1,
  },
}));
const h = state;

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
    worldPerPixel(world: Vec3): number {
      const camera = this.syncCamera();
      if (this.ortho) {
        return (this.orthographic.top - this.orthographic.bottom) / Math.max(1, this.height);
      }
      const pos = camera.position;
      const dist = Math.hypot(world.x - pos.x, world.y - pos.y, world.z - pos.z);
      const fov = (45 * Math.PI) / 180;
      return (2 * Math.max(1, dist) * Math.tan(fov / 2)) / Math.max(1, this.height);
    }
    projector() {
      this.syncCamera();
      if (state.simpleProjector) return state.projector;
      return {
        project: (world: Vec3) => this.project(world),
        ray: (screen: Vec2) => this.ray(screen),
        worldPerPixel: (world: Vec3) => this.worldPerPixel(world),
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
    setVisible() {}
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
    guide: EdgeGuide | null = null;
    displayStyle: 'xray' | 'shaded' = 'xray';
    presentation = false;
    constructor() {
      state.renderer = this;
    }
    setDisplayStyle(style: 'xray' | 'shaded') {
      this.displayStyle = style;
    }
    setPresentation(active: boolean) {
      this.presentation = active;
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
    setEdgeGuide(guide: EdgeGuide | null) {
      this.guide = guide;
    }
    setGhost(points: Vec3[] | null, closed: boolean, label: { text: string; at: Vec3 } | null = null) {
      this.ghost = points ? { points, closed, label } : null;
      state.ghost = points ? { points: [...points], closed } : null;
    }
    setLineGuide(points: readonly Vec3[] | null, label: { text: string; at: Vec3 } | null) {
      state.guide(points, label);
    }
    setSelected() {}
    setExtrusion() {}
    setActiveFace() {}
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
    flash(text: string) {
      state.flashes.push(text);
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
    lastLabel = '';
    lastInitial = '';
    onSubmit: ((text: string) => void) | null = null;
    constructor() {
      state.measure = this;
    }
    open(label: string, onSubmit: (text: string) => void, _onClose?: () => void, initialValue?: string) {
      this.isOpen = true;
      this.lastLabel = label;
      this.lastInitial = initialValue ?? '';
      this.onSubmit = onSubmit;
    }
    close() {
      this.isOpen = false;
      this.onSubmit = null;
    }
    submit(text: string) {
      const submit = this.onSubmit;
      this.close();
      if (text && submit) submit(text);
    }
  }
  return { MeasureInput };
});

vi.mock('./ui/pip', () => {
  class CameraPip {
    visible = true;
    source: string | null = null;
    setThumb() {}
    setCameraState() {}
    setHands() {}
    setSpatial() {}
    setStream() {}
    setSource(source: string) {
      this.source = source;
    }
    toggle() {
      return false;
    }
  }
  return { CameraPip };
});

vi.mock('./ui/cursor-glyph', () => {
  class CursorGlyph {
    update(...args: unknown[]) {
      state.glyph.update(...args);
    }
  }
  return { CursorGlyph };
});

vi.mock('./ui/input-panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/input-panel')>();
  class InputPanel {
    constructor(_root: unknown, handlers: unknown) {
      state.panelHandlers = handlers;
    }
    update(next: unknown) {
      state.panel = next;
    }
  }
  return { ...actual, InputPanel };
});

const fakeRegionElement = () => {
  const element: Record<string, any> = {
    className: '',
    tabIndex: 0,
    style: {},
    dataset: {},
    children: [] as unknown[],
    appendChild(child: unknown) {
      element.children.push(child);
      return child;
    },
    append(...children: unknown[]) {
      element.children.push(...children);
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    querySelector() {
      return null;
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600 };
    },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  return element;
};

vi.mock('./ui/workspace', () => {
  class WorkspaceShell {
    readonly regions = {
      appBar: fakeRegionElement(),
      commandBar: fakeRegionElement(),
      modelBrowser: fakeRegionElement(),
      viewControls: fakeRegionElement(),
      viewport: fakeRegionElement(),
      viewportOverlay: fakeRegionElement(),
      inspector: fakeRegionElement(),
      input: fakeRegionElement(),
      cameraPreview: fakeRegionElement(),
      statusBar: fakeRegionElement(),
      notifications: fakeRegionElement(),
      dialogs: fakeRegionElement(),
    };
    presentation = false;
    constructor() {
      state.shell = this;
    }
    get presenting() {
      return this.presentation;
    }
    get layout() {
      return this.presentation
        ? { browserVisible: false, inspectorVisible: false, inspectorTab: 'properties' as const }
        : { browserVisible: true, inspectorVisible: true, inspectorTab: 'properties' as const };
    }
    setPresentation(active: boolean) {
      this.presentation = active;
    }
    onLayoutChange() {
      return () => {};
    }
    setLayout() {}
    setEntityCount() {}
  }
  return { WorkspaceShell };
});

vi.mock('./ui/command-bar', () => {
  class AppBar {
    constructor(_host: unknown, callbacks: unknown) {
      state.commands = callbacks;
    }
    update() {}
  }
  class CommandBar {
    constructor(_host: unknown, callbacks: unknown) {
      state.commands = callbacks;
    }
    update() {}
  }
  return { AppBar, CommandBar };
});

vi.mock('./ui/view-controls', () => ({
  ViewControls: class {
    constructor() {}
    update() {}
  },
}));

// Browser/inspector render against the real DOM in the browser; in Node the
// stub elements can't carry them, so they are covered by dispatcher tests.
vi.mock('./ui/model-browser', () => ({
  ModelBrowser: class {
    constructor(_host: unknown, _callbacks: unknown) {}
    update() {}
  },
}));

vi.mock('./ui/inspector', () => ({
  Inspector: class {
    constructor(_host: unknown, _callbacks: unknown) {}
    update() {}
  },
}));

vi.mock('./scene/spatial-cursor-visual', () => {
  class SpatialCursorVisual {
    readonly group = new THREE.Group();
    update() {}
  }
  return { SpatialCursorVisual };
});

vi.mock('./input/tracker-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./input/tracker-client')>();
  class MockTracker {
    clock = { synced: true, offsetLower: 0, rttMs: 1 };
    lastSnapshot: Record<string, unknown> | null = null;
    lastStatus = null;
    constructor(_url: string, handlers: unknown) {
      state.tracker = handlers;
      state.trackerClient = this;
    }
    connect() {}
    close() {}
  }
  return { ...actual, TrackerClient: MockTracker, defaultTrackerUrl: () => 'ws://test' };
});

vi.mock('./voice/control', () => ({
  VoiceControl: class {
    toggle = vi.fn();
    cancel = vi.fn();
    busy = false;
    constructor(_root: unknown, options: VoiceControlOptions) {
      state.voice = options;
      state.voiceControl = this;
    }
  },
}));

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
  readonly listeners = new Map<string, EventListener[]>();
  appendChild<T>(child: T): T {
    this.children.push(child);
    return child;
  }
  append(...children: unknown[]): void {
    this.children.push(...children);
  }
  addEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  dispatch(type: string, event: { target?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event);
  }
  focus(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

const appRoot = new FakeElement();

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

const FRAME = { w: 640, h: 480 };

function tipFor(px: number, py: number): [number, number] {
  return [FRAME.w * 0.12 + (px / 800) * FRAME.w * 0.76, FRAME.h * 0.12 + (py / 600) * FRAME.h * 0.76];
}

function handAt(px: number, py: number, overrides: Partial<TrackedHandMessage> = {}, nav: NavMessage | null = null): HandsMessage {
  const hand: TrackedHandMessage = {
    id: 1,
    handedness: 'right',
    tip: tipFor(px, py),
    thumb: [0, 0],
    palm: [0, 0],
    palmSize: 80,
    pinching: false,
    open: false,
    openArmed: false,
    landmarks: [],
    ...overrides,
  };
  return { type: 'hands', t: state.nowMs / 1000, frame: { ...FRAME }, hands: [hand], nav };
}

const emitHands = (message: HandsMessage): void => state.tracker?.onHands?.(message);
const setHand = (p: Vec2): void => emitHands(handAt(p.x, p.y));
const runFrame = (): void => tick();

function startExtrusion(setCursor: (p: Vec2) => void = (p) => api.setCursor(p)): string {
  api.commands.addRect([v3(100, 100, 0), v3(500, 100, 0), v3(500, 400, 0), v3(100, 400, 0)]);
  const serialized = api.sketch.serialize();
  setCursor(v2(250, 250));
  api.press('select');
  setGrid(false);
  api.press('extrude');
  return serialized;
}

function useScreenSpaceProjector(): void {
  const spies: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    state.simpleProjector = true;
    state.nowMs = 10_000;
    dispatchWindow('focus', {});
    setGrid(false);
    spies.push(
      vi.spyOn(OrbitController.prototype, 'worldPerPixel').mockReturnValue(1),
      vi.spyOn(OrbitController.prototype, 'zoom').mockImplementation((...args: unknown[]) => {
        state.orbit.zoom(...args);
        return undefined as never;
      }),
      vi.spyOn(OrbitController.prototype, 'orbit').mockImplementation((...args: unknown[]) => {
        state.orbit.orbit(...args);
      }),
      vi.spyOn(OrbitController.prototype, 'pan').mockImplementation((...args: unknown[]) => {
        state.orbit.pan(...args);
      }),
      vi.spyOn(performance, 'now').mockImplementation(() => state.nowMs),
    );
    state.orbit.zoom.mockClear();
    state.orbit.orbit.mockClear();
    state.orbit.pan.mockClear();
    state.guide.mockClear();
    state.glyph.update.mockClear();
    state.voiceControl?.toggle.mockClear();
    state.voiceControl?.cancel.mockClear();
    state.ghost = null;
  });
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    state.simpleProjector = false;
  });
}

beforeAll(async () => {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => new FakeElement(),
    getElementById: () => appRoot,
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
  if (state.voiceControl) state.voiceControl.busy = false;
  dispatchWindow('blur', {});
  api.setTrackerSource('webcam');
  state.tracker?.onConnection('closed');
  // A failed test may leave Reveal active; Escape restores editing first.
  tick();
  if ((state.hud?.last as { presentation?: boolean } | null)?.presentation) api.press('cancel');
  api.sketch.load({ version: 1, units: 'mm', entities: [] });
  api.press('clear');
  api.press('viewTop');
  finishTransitions();
  if (api.planeMode() === 'manual') api.press('toggleAutoPlane');
  setGrid(true);
  state.toasts.length = 0;
  state.flashes.length = 0;
  state.resolveCalls = 0;
  state.guide.mockClear();
  state.glyph.update.mockClear();
  state.orbit.zoom.mockClear();
  state.orbit.orbit.mockClear();
  state.orbit.pan.mockClear();
  state.voiceControl?.toggle.mockClear();
  state.voiceControl?.cancel.mockClear();
  state.ghost = null;
  dispatchWindow('focus', {});
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
    // Routine feedback now lands in the status-bar flash, not the toast stack.
    expect([...state.toasts, ...state.flashes].some((message) => message.includes('already exists'))).toBe(true);
    api.commands.undo();
    expect(api.sketch.size).toBe(0);
    expect(api.commands.undo()).toBeNull();
  });

  it('aligns a rough adjacent rectangle to the whole shared border in preview and commit', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    api.press('viewTop');
    finishTransitions();
    setGrid(false);
    setCursorWorld(v3(4000, 500, 0));
    api.hold('draw', true);
    for (const point of [v3(7700, 500, 0), v3(7700, 1500, 0), v3(7700, 2500, 0), v3(4000, 2500, 0)]) setCursorWorld(point);
    tick();
    const ghost = state.renderer.ghost;
    expect(ghost).not.toBeNull();
    const expected = [v3(4000, 0, 0), v3(8000, 0, 0), v3(8000, 3000, 0), v3(4000, 3000, 0)];
    for (const corner of expected) {
      expect(ghost!.points.some((point: Vec3) => Math.hypot(point.x - corner.x, point.y - corner.y, point.z - corner.z) < 1e-3)).toBe(true);
    }
    api.hold('draw', false);
    expect(api.sketch.size).toBe(2);
    const floor = api.sketch.all[0];
    if (floor.type === 'rect') {
      expect(floor.corners).toEqual(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    }
    const committed = api.sketch.all[1];
    expect(committed.type).toBe('rect');
    if (committed.type !== 'rect') throw new Error('expected a committed rectangle');
    expect(committed.corners).toEqual(expected);
    api.commands.undo();
    expect(api.sketch.size).toBe(1);
    api.commands.redo();
    expect(api.sketch.size).toBe(2);
    const restored = api.sketch.all[1];
    expect(restored.id).toBe(committed.id);
    if (restored.type === 'rect') expect(restored.corners).toEqual(committed.corners);

    const secondLoop = [v3(11800, 500, 0), v3(11800, 2500, 0), v3(8100, 2500, 0), v3(8100, 500, 0), v3(11800, 500, 0)];
    strokeThrough(secondLoop);
    expect(api.lastRecognition()?.reason).toBe('rectangle');
    expect(api.sketch.size).toBe(3);
    const second = api.sketch.all[2];
    if (second.type !== 'rect') throw new Error('expected the aligned outline to commit');
    expect(second.corners).toHaveLength(4);
    for (const corner of [v3(8000, 0, 0), v3(12000, 0, 0), v3(12000, 3000, 0), v3(8000, 3000, 0)]) {
      expect(second.corners.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y, point.z - corner.z) < 1e-3)).toBe(true);
    }
    strokeThrough(secondLoop);
    expect(api.lastRecognition()?.reason).toBe('rectangle already exists');
    expect(api.sketch.size).toBe(3);
    api.commands.undo();
    expect(api.sketch.size).toBe(2);
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
    tick();
    expect(api.plane().offset).toBeCloseTo(2500, 5);
    expect(api.plane().kind).toBe('XY');
    expect(state.hud.last?.planeMode).toBe('Auto');
    expect(state.hud.last?.planeReason).toBe('hovered face');
  });

  it('slides the highlighted plane through an off-plane vertex without waiting for dwell', () => {
    const point = v3(2000, 1500, 2500);
    api.commands.addLine(point, v3(3000, 1500, 2500));
    expect(api.plane().contains(point)).toBe(false);
    setCursorWorld(point);
    tick();
    expect(api.plane().contains(point)).toBe(true);
    expect(state.planeVisual.last?.plane.offset).toBeCloseTo(api.plane().offset, 5);
    expect(state.hud.last?.planeReason).toBe('snapped vertex');
  });

  it('keeps a Tab-cycled plane through the hovered corner', () => {
    const corner = v3(4000, 3000, 0);
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    setCursorWorld(corner);
    api.press('cyclePlane');
    expect(api.plane().kind).toBe('XZ');
    expect(api.plane().contains(corner)).toBe(true);
    expect(api.plane().offset).toBeCloseTo(3000, 5);
  });

  it('uses the inferred plane for visuals in the same frame it switches', () => {
    api.commands.addRect(makeRect(v3(0, 0, 2500), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    const px = api.project(v3(2000, 1500, 2500))!;
    setCursorWorld(v3(2000, 1500, 2500));
    tick();
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
    api.setCursor(v2(400, 300));
    dispatchWindow('keydown', keyEvent('ShiftLeft'));
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

  it('ignores Space and Enter when the target is inside CAD chrome', () => {
    setCursorWorld(v3(0, 0, 0));
    const chromeTarget = { closest: (selector: string) => (selector === '[data-cad-ui]' ? {} : null) };
    dispatchWindow('keydown', keyEvent('Space', { target: chromeTarget }));
    dispatchWindow('keydown', keyEvent('Enter', { target: chromeTarget }));
    tick();
    expect(state.hud.last?.mode).toBe('READY');
    dispatchWindow('keyup', keyEvent('Space', { target: chromeTarget }));
    dispatchWindow('keyup', keyEvent('Enter', { target: chromeTarget }));
    expect(api.sketch.size).toBe(0);
  });

  it('still draws when the keydown target is the viewport', () => {
    setCursorWorld(v3(0, 0, 0));
    dispatchWindow('keydown', keyEvent('Space', { target: { closest: () => null } }));
    tick();
    expect(state.hud.last?.mode).toBe('DRAWING');
    setCursorWorld(v3(4000, 0, 0));
    dispatchWindow('keyup', keyEvent('Space', { target: { closest: () => null } }));
    expect(api.sketch.size).toBe(1);
  });

  it('releases a hold on keyup even when the target moved into chrome', () => {
    setCursorWorld(v3(0, 0, 0));
    dispatchWindow('keydown', keyEvent('Space', { target: { closest: () => null } }));
    tick();
    expect(state.hud.last?.mode).toBe('DRAWING');
    setCursorWorld(v3(4000, 0, 0));
    const chromeTarget = { closest: (selector: string) => (selector === '[data-cad-ui]' ? {} : null) };
    dispatchWindow('keyup', keyEvent('Space', { target: chromeTarget }));
    expect(api.sketch.size).toBe(1);
    expect(api.sketch.all[0].type).toBe('line');
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

const ORIGIN_CAM = v3(0, 0, 500);

function worldToCamera(world: Vec3, origin = ORIGIN_CAM): [number, number, number] {
  return [-world.x + origin.x, world.z + origin.y, world.y + origin.z];
}

let spatialSeq = 1;

function spatialAt(world: Vec3, over: Partial<SpatialMessage> = {}): SpatialMessage {
  const now = frameTime || 1000;
  return {
    type: 'spatial',
    v: 2,
    streamId: 's1',
    sourceRunId: 'r1',
    seq: spatialSeq++,
    t: now,
    sampleTimeMs: now,
    ageMs: 0,
    target: 'color',
    trackingEpoch: 0,
    frame: { w: 100, h: 80, mirrored: true },
    pixel: [40, 40],
    cameraMm: worldToCamera(world),
    state: 'tracked',
    fresh: true,
    reason: null,
    quality: { validPixels: 12, roiCount: 3, spreadMm: 2, pairSkewMs: 1 },
    ...over,
  };
}

function enablePlanarDepth(): void {
  api.setTrackerSource('oak');
  api.setDepthScale(1);
  api.setSpatialOrigin(ORIGIN_CAM);
}

function strokeThroughSpatial(worldPoints: Vec3[]): void {
  tick();
  api.pushSpatial(spatialAt(worldPoints[0]));
  api.hold('draw', true);
  for (const point of worldPoints.slice(1)) {
    tick();
    api.pushSpatial(spatialAt(point));
  }
  api.hold('draw', false);
}

describe('depth planar strokes', () => {
  it('previews and commits a depth-drawn triangle through the shared stroke pipeline', () => {
    enablePlanarDepth();
    const corners = [v3(0, 0, 0), v3(4000, 0, 0), v3(1200, 3000, 0)];
    api.pushSpatial(spatialAt(corners[0]));
    api.hold('draw', true);
    for (const point of [...corners.slice(1), corners[0]]) {
      tick();
      api.pushSpatial(spatialAt(point));
    }
    tick();
    expect(state.renderer.ghost?.points).toHaveLength(3);
    api.hold('draw', false);
    expect(api.lastRecognition()?.reason).toBe('triangle');
    expect(api.sketch.last).toMatchObject({ type: 'triangle', corners });
    const committed = api.sketch.serialize();
    api.press('undo');
    expect(api.sketch.size).toBe(0);
    api.press('redo');
    expect(api.sketch.serialize()).toBe(committed);
  });

  it('projects measured points onto the work plane and completes a rectangle', () => {
    enablePlanarDepth();
    strokeThroughSpatial([
      v3(0, 0, 80),
      v3(4000, 0, 40),
      v3(4000, 3000, 90),
      v3(0, 3000, 20),
      v3(0, 0, 10),
    ]);
    expect(api.lastRecognition()?.reason).toBe('rectangle');
    expect(api.sketch.size).toBe(1);
    const entity = api.sketch.all[0];
    expect(entity.type).toBe('rect');
    if (entity.type === 'rect') {
      const expected = [v3(0, 0, 0), v3(4000, 0, 0), v3(4000, 3000, 0), v3(0, 3000, 0)];
      for (const corner of expected) {
        expect(entity.corners.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y, point.z - corner.z) < 1e-3)).toBe(true);
      }
    }
  });

  it('completes a shared-border wall from projected depth points', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    api.press('viewRight');
    finishTransitions();
    enablePlanarDepth();
    strokeThroughSpatial([
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
    expect(api.sketch.all[1].type).toBe('rect');
    api.commands.undo();
    expect(api.sketch.size).toBe(1);
  });

  it('starts a planar stroke on an edge-on plane with a view warning', () => {
    api.press('viewFront');
    finishTransitions();
    api.press('cyclePlane');
    expect(api.plane().kind).toBe('YZ');
    enablePlanarDepth();
    tick();
    api.pushSpatial(spatialAt(v3(80, 400, 200)));
    api.hold('draw', true);
    expect(state.toasts.some((message) => message.includes('edge-on'))).toBe(true);
    tick();
    api.pushSpatial(spatialAt(v3(120, 800, 900)));
    api.hold('draw', false);
    expect(api.sketch.size).toBe(1);
    expect(api.sketch.all[0].type).toBe('line');
  });
});

describe('depth planar snapping', () => {
  it('defaults depth scale to 10 when entering depth mode', () => {
    try {
      globalThis.localStorage?.removeItem('aircad.depthScale');
    } catch {
      /* node */
    }
    api.setTrackerSource('oak');
    expect(api.mappingScale()).toBe(10);
  });

  it('recognizes a jittered loop as a rectangle', () => {
    enablePlanarDepth();
    strokeThroughSpatial([
      v3(0, 0, 12),
      v3(2000, 20, -8),
      v3(4000, -10, 15),
      v3(3980, 1500, -6),
      v3(4010, 3000, 14),
      v3(2000, 2985, -11),
      v3(10, 3010, 8),
      v3(-8, 1500, -4),
      v3(18, 12, 6),
    ]);
    expect(api.lastRecognition()?.reason).toBe('rectangle');
    expect(api.sketch.size).toBe(1);
    expect(api.sketch.all[0].type).toBe('rect');
  });

  it('assembles four chained strokes into a rectangle', () => {
    enablePlanarDepth();
    strokeThroughSpatial([v3(0, 0, 0), v3(2000, 0, 8), v3(4000, 0, 0)]);
    expect(api.sketch.size).toBe(1);
    strokeThroughSpatial([v3(4000, 0, 0), v3(4000, 1500, -6), v3(4000, 3000, 0)]);
    expect(api.sketch.size).toBe(2);
    strokeThroughSpatial([v3(4000, 3000, 0), v3(2000, 3000, 10), v3(0, 3000, 0)]);
    expect(api.sketch.size).toBe(3);
    strokeThroughSpatial([v3(0, 3000, 0), v3(0, 1500, -5), v3(0, 0, 0)]);
    expect(api.lastRecognition()?.reason).toBe('assembled rectangle');
    expect(api.sketch.size).toBe(1);
    expect(api.sketch.all[0].type).toBe('rect');
  });

  it('joins an endpoint 35 mm off a vertex', () => {
    api.commands.addLine(v3(0, 0, 0), v3(500, 0, 0));
    enablePlanarDepth();
    strokeThroughSpatial([v3(2000, 0, 0), v3(1000, 0, 4), v3(35, 0, 0)]);
    expect(api.sketch.size).toBe(2);
    const line = api.sketch.all[1];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.b).toEqual(v3(0, 0, 0));
    }
  });

  it('commits a near-axis stroke as an axis-aligned line', () => {
    enablePlanarDepth();
    strokeThroughSpatial([v3(0, 0, 0), v3(500, 20, 8), v3(1000, 80, 40)]);
    expect(api.lastRecognition()?.reason).toBe('axis-aligned line');
    expect(api.sketch.size).toBe(1);
    const line = api.sketch.all[0];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.a).toEqual(v3(0, 0, 0));
      expect(line.b.y).toBeCloseTo(0, 5);
      expect(line.b.z).toBeCloseTo(0, 5);
    }
  });

  it('projects a tilted stroke onto the work plane', () => {
    enablePlanarDepth();
    strokeThroughSpatial([v3(0, 0, 0), v3(500, 80, 20), v3(1000, 150, 40)]);
    expect(api.sketch.size).toBe(1);
    const line = api.sketch.all[0];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.b.z).toBeCloseTo(0, 5);
    }
  });

  it('snaps a 20Ã¢ÂÂ¬Ã¢ÂÂ planar stroke to a world axis', () => {
    enablePlanarDepth();
    const angle = (20 * Math.PI) / 180;
    strokeThroughSpatial([
      v3(0, 0, 0),
      v3(Math.cos(angle) * 400, Math.sin(angle) * 400, 8),
      v3(Math.cos(angle) * 800, Math.sin(angle) * 800, 12),
    ]);
    expect(api.lastRecognition()?.reason).toBe('axis-aligned line');
    const line = api.sketch.all[0];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.b.y).toBeCloseTo(0, 5);
      expect(line.b.z).toBeCloseTo(0, 5);
    }
  });

  it('prompts for a 45Ã¢ÂÂ¬Ã¢ÂÂ planar angle and applies the typed value', () => {
    enablePlanarDepth();
    strokeThroughSpatial([v3(0, 0, 0), v3(400, 400, 10), v3(800, 800, 20)]);
    expect(api.lastRecognition()?.reason).toBe('plane-locked line');
    expect(state.measure.isOpen).toBe(true);
    expect(Number(state.measure.lastInitial)).toBeCloseTo(45, 0);
    state.measure.submit('30');
    const line = api.sketch.all[0];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect((Math.atan2(line.b.y, line.b.x) * 180) / Math.PI).toBeCloseTo(30, 4);
      expect(line.b.z).toBeCloseTo(0, 5);
    }
  });

  it('snaps a nearby stroke onto an existing diagonal as a parallel line', () => {
    const angle = (38 * Math.PI) / 180;
    const along = { x: Math.cos(angle), y: Math.sin(angle) };
    api.commands.addLine(v3(0, 0, 0), v3(along.x * 4000, along.y * 4000, 0));
    enablePlanarDepth();
    api.press('fitAll');
    finishTransitions();
    const drawn = (46 * Math.PI) / 180;
    const perp = { x: -along.y, y: along.x };
    const start = v3(along.x * 1600 + perp.x * 650, along.y * 1600 + perp.y * 650, 0);
    strokeThroughSpatial([
      start,
      v3(start.x + Math.cos(drawn) * 700, start.y + Math.sin(drawn) * 700, 4),
      v3(start.x + Math.cos(drawn) * 1400, start.y + Math.sin(drawn) * 1400, 6),
      v3(start.x + Math.cos(drawn) * 2000, start.y + Math.sin(drawn) * 2000, 8),
    ]);
    expect(api.lastRecognition()?.reason).toBe('parallel line');
    expect(state.measure.isOpen).toBe(false);
    const line = api.sketch.all[1];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect((Math.atan2(line.b.y - line.a.y, line.b.x - line.a.x) * 180) / Math.PI).toBeCloseTo(38, 4);
    }
  });

  it('shows a vertex snap in the HUD before pen-down', () => {
    api.commands.addLine(v3(0, 0, 0), v3(500, 0, 0));
    enablePlanarDepth();
    api.pushSpatial(spatialAt(v3(10, 0, 0)));
    tick();
    expect(state.hud.last?.snap).toBe('vertex');
  });

  it('shows decided-by-stroke before pen-down in depth auto', () => {
    enablePlanarDepth();
    tick();
    expect(state.hud.last?.planeMode).toBe('Auto');
    expect(state.hud.last?.planeReason).toBe('decided by stroke');
    expect(api.plane().kind).toBe('XY');
  });

  it('commits a vertical stroke as a standing line while the last plane was XY', () => {
    enablePlanarDepth();
    expect(api.plane().kind).toBe('XY');
    strokeThroughSpatial([v3(0, 0, 0), v3(4, 2, 400), v3(8, 3, 800)]);
    expect(api.sketch.size).toBe(1);
    const line = api.sketch.all[0];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.b.z).toBeGreaterThan(700);
      expect(Math.abs(line.b.x) + Math.abs(line.b.y)).toBeLessThan(20);
    }
    expect(api.plane().kind).not.toBe('XY');
  });

  it('locks an X-then-Z wall rectangle onto XZ', () => {
    enablePlanarDepth();
    expect(api.plane().kind).toBe('XY');
    strokeThroughSpatial([
      v3(0, 0, 0),
      v3(2000, 0, 8),
      v3(4000, 0, 0),
      v3(4000, 20, 1200),
      v3(4000, -10, 2500),
      v3(2000, 15, 2500),
      v3(0, -8, 2500),
      v3(0, 12, 1200),
      v3(0, 0, 0),
    ]);
    expect(api.lastRecognition()?.reason).toBe('rectangle');
    expect(api.sketch.size).toBe(1);
    const entity = api.sketch.all[0];
    expect(entity.type).toBe('rect');
    if (entity.type === 'rect') {
      for (const corner of entity.corners) expect(corner.y).toBeCloseTo(0, 3);
      expect(entity.corners.some((corner) => Math.abs(corner.z - 2500) < 1)).toBe(true);
    }
    expect(api.plane().kind).toBe('XZ');
  });

  it('keeps a straight floor stroke on XY by continuity', () => {
    enablePlanarDepth();
    strokeThroughSpatial([v3(0, 0, 0), v3(400, 0, 6), v3(800, 0, 4)]);
    expect(api.plane().kind).toBe('XY');
    const line = api.sketch.all[0];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.b.y).toBeCloseTo(0, 5);
      expect(line.b.z).toBeCloseTo(0, 5);
    }
  });

  it('still flattens onto a pinned plane in manual depth mode', () => {
    enablePlanarDepth();
    api.press('cyclePlane');
    expect(api.planeMode()).toBe('manual');
    expect(api.plane().kind).toBe('XZ');
    strokeThroughSpatial([v3(0, 0, 0), v3(500, 400, 8), v3(1000, 800, 12)]);
    const line = api.sketch.all[0];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.b.y).toBeCloseTo(0, 5);
      expect(line.b.z).toBeCloseTo(0, 5);
    }
  });
});

describe('workspace dispatcher', () => {
  it('rejects UI measure/extrude/delete without an explicit selection', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    expect(api.selected()).toBeNull();
    for (const action of ['measure', 'extrude', 'delete'] as const) {
      const result = state.commands.dispatch({ type: 'press', action });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
    expect(api.sketch.size).toBe(1);
    expect(api.extrusion()).toBeNull();
  });

  it('selects by id, then allows Push/Pull and Dimensions on the selection', () => {
    const rect = api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    expect(rect.ok).toBe(true);
    const id = api.sketch.all[0].id;
    expect(state.commands.dispatch({ type: 'selectEntity', id: 'missing' }).ok).toBe(false);
    expect(state.commands.dispatch({ type: 'selectEntity', id })).toEqual({ ok: true });
    expect(api.selected()?.id).toBe(id);
    expect(state.commands.dispatch({ type: 'press', action: 'extrude' })).toEqual({ ok: true });
    expect(api.extrusion()).not.toBeNull();
    api.press('cancel');
    expect(api.extrusion()).toBeNull();
    expect(state.commands.dispatch({ type: 'press', action: 'measure' })).toEqual({ ok: true });
    expect(state.measure.isOpen).toBe(true);
    state.measure.close();
  });

  it('pins a manual work plane without moving the camera', () => {
    const before = state.viewport.perspective.quaternion.clone();
    expect(state.commands.dispatch({ type: 'setWorkPlane', plane: 'XZ' })).toEqual({ ok: true });
    expect(api.planeMode()).toBe('manual');
    expect(api.plane().kind).toBe('XZ');
    finishTransitions();
    expect(state.viewport.perspective.quaternion.equals(before)).toBe(true);
    expect(state.commands.dispatch({ type: 'setWorkPlane', plane: 'auto' })).toEqual({ ok: true });
    expect(api.planeMode()).toBe('auto');
  });

  it('rejects setWorkPlane and selection while a stroke is running', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    setCursorWorld(v3(0, 0, 0));
    api.hold('draw', true);
    expect(state.commands.dispatch({ type: 'setWorkPlane', plane: 'XZ' }).ok).toBe(false);
    expect(state.commands.dispatch({ type: 'selectEntity', id: api.sketch.all[0].id }).ok).toBe(false);
    expect(state.commands.dispatch({ type: 'press', action: 'undo' }).ok).toBe(false);
    api.hold('draw', false);
  });

  const frameOf = (id: string) => {
    const entity = api.sketch.get(id);
    if (!entity || entity.type === 'line' || entity.type === 'circle') throw new Error('expected a profile entity');
    return rectFrame(entity);
  };

  it('resizes a rectangle via setDimension in exactly one undoable step', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 2000, 1000));
    const id = api.sketch.all[0].id;
    expect(state.commands.dispatch({ type: 'selectEntity', id })).toEqual({ ok: true });
    expect(state.commands.dispatch({ type: 'setDimension', id, spec: '4 m x 300 cm' })).toEqual({ ok: true });
    const { width, height } = frameOf(id);
    expect(width).toBeCloseTo(4000);
    expect(height).toBeCloseTo(3000);
    api.commands.undo();
    const back = frameOf(id);
    expect(back.width).toBeCloseTo(2000);
    expect(back.height).toBeCloseTo(1000);
    expect(api.sketch.size).toBe(1);
    api.commands.undo();
    expect(api.sketch.size).toBe(0);
  });

  it('rejects invalid, empty, and non-positive dimensions without touching history', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 2000, 1000));
    const id = api.sketch.all[0].id;
    state.commands.dispatch({ type: 'selectEntity', id });
    for (const spec of ['abc', '', '-5']) {
      const result = state.commands.dispatch({ type: 'setDimension', id, spec });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
    expect(frameOf(id).width).toBeCloseTo(2000);
    expect(api.commands.undo()).toBe('add rect');
    expect(api.sketch.size).toBe(0);
  });

  it('rejects setDimension for a stale id and while extruding', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 2000, 1000));
    const id = api.sketch.all[0].id;
    state.commands.dispatch({ type: 'selectEntity', id });
    expect(state.commands.dispatch({ type: 'setDimension', id: 'gone', spec: '1000' }).ok).toBe(false);
    expect(state.commands.dispatch({ type: 'press', action: 'extrude' })).toEqual({ ok: true });
    expect(state.commands.dispatch({ type: 'setDimension', id, spec: '1000' }).ok).toBe(false);
    api.press('cancel');
    expect(api.extrusion()).toBeNull();
  });

  it('resizes a box base without changing depth, and edits depth without changing the base', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 2000, 1000));
    const id = api.sketch.all[0].id;
    expect(api.commands.extrude(id, 600).ok).toBe(true);
    state.commands.dispatch({ type: 'selectEntity', id });
    expect(state.commands.dispatch({ type: 'setDimension', id, spec: '5000 x 2000' })).toEqual({ ok: true });
    let entity = api.sketch.get(id)!;
    let frame = frameOf(id);
    expect(frame.width).toBeCloseTo(5000);
    expect(frame.height).toBeCloseTo(2000);
    if (entity.type !== 'extrusion') throw new Error('expected extrusion');
    expect(entity.depth).toBeCloseTo(600);
    expect(state.commands.dispatch({ type: 'setDimension', id, spec: '-800' })).toEqual({ ok: true });
    entity = api.sketch.get(id)!;
    frame = frameOf(id);
    expect(frame.width).toBeCloseTo(5000);
    expect(frame.height).toBeCloseTo(2000);
    if (entity.type !== 'extrusion') throw new Error('expected extrusion');
    expect(entity.depth).toBeCloseTo(-800);
  });
});

describe('tracker snapshot adoption', () => {
  const snapshot = (source: string, depthai = false) => ({
    ok: true,
    config: { source, cameraIndex: 0, target: 'finger', colorPreset: 'green', colorTolerance: 1 },
    camera: source === 'none' ? 'disabled' : 'ready',
    message: '',
    streamId: 's1',
    sourceRunId: null,
    capabilities: { sources: ['webcam', 'oak', 'none'], depthTargets: ['finger', 'color'], depthaiInstalled: depthai },
    serverTimeMs: 0,
  });

  it('adopts the server config from a snapshot when idle', () => {
    state.trackerClient.lastSnapshot = snapshot('oak', true);
    state.tracker.onSnapshot(snapshot('none'));
    expect(state.panel.source).toBe('none');
    state.trackerClient.lastSnapshot = snapshot('webcam');
    state.tracker.onSnapshot(snapshot('webcam'));
    expect(state.panel.source).toBe('webcam');
    expect(state.panel.depthaiInstalled).toBe(false);
  });

  it('ignores snapshots while a config change is in flight and guards duplicates', async () => {
    state.trackerClient.lastSnapshot = snapshot('none');
    state.tracker.onSnapshot(snapshot('none'));
    expect(state.panel.source).toBe('none');
    // Each onSource fires applyTracker; the POST fails asynchronously, so the
    // second call lands while the first is still in flight.
    state.panelHandlers.onSource('webcam');
    state.panelHandlers.onSource('oak');
    state.tracker.onSnapshot(snapshot('oak'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.flashes).toContain('Still applying the previous change…');
    expect(state.panel.source).toBe('none');
  });
});

describe('chrome boundary for detached targets', () => {
  it('ignores a keydown whose target was detached mid-dispatch', () => {
    api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 2000, 1000));
    const id = api.sketch.all[0].id;
    expect(state.commands.dispatch({ type: 'selectEntity', id })).toEqual({ ok: true });
    // A row that removed itself mid-dispatch no longer reaches [data-cad-ui].
    dispatchWindow('keydown', keyEvent('Delete', { target: { isConnected: false, closest: () => null } }));
    expect(api.sketch.get(id)).toBeTruthy();
    // A connected non-chrome target still reaches the CAD shortcut.
    dispatchWindow('keydown', keyEvent('Delete', { target: { isConnected: true, closest: () => null } }));
    expect(api.sketch.get(id)).toBeUndefined();
  });
});

describe('closed outlines and line loops', () => {
  useScreenSpaceProjector();

  const drawStroke = (points: Vec2[]): void => {
    api.setCursor(points[0]);
    api.hold('draw', true);
    for (const point of points.slice(1)) api.setCursor(point);
    api.hold('draw', false);
  };

  const drawTriangleLoop = (): { a: Vec2; b: Vec2; c: Vec2 } => {
    const a = v2(100, 100);
    const b = v2(500, 100);
    const c = v2(200, 400);
    drawStroke([a, b]);
    drawStroke([b, c]);
    drawStroke([c, a]);
    return { a, b, c };
  };

  it('draws a triangle, then Q + drag + typed depth + Enter commits it exactly once', () => {
    drawStroke([v2(100, 100), v2(500, 100), v2(200, 400), v2(100, 100)]);
    const triangle = api.sketch.last;
    expect(triangle?.type).toBe('triangle');
    if (triangle?.type !== 'triangle') throw new Error('expected triangle');
    expect(triangle.corners).toHaveLength(3);
    const saved = api.sketch.serialize();

    api.setCursor(v2(250, 200));
    api.press('select');
    expect(api.selected()?.id).toBe(triangle.id);
    api.press('extrude');
    expect(api.extrusion()).toMatchObject({ depth: 0 });
    api.hold('draw', true);
    api.setCursor(v2(250, 150));
    expect(api.extrusion()!.depth).toBe(50);
    api.hold('draw', false);
    expect(api.extrusion()).not.toBeNull();
    expect(api.sketch.serialize()).toBe(saved);

    api.press('measure');
    h.measure.submit?.('12.345');
    expect(api.extrusion()!.depth).toBeCloseTo(12.345);
    api.press('confirm');
    expect(api.extrusion()).toBeNull();
    expect(api.sketch.get(triangle.id)).toMatchObject({ type: 'prism', depth: 12.345, corners: triangle.corners });
    expect(api.commands.undo()).toBe('extrude prism 12.3 mm');
    expect(api.sketch.serialize()).toBe(saved);
  });

  it('follows the same Q path with a hand pinch', () => {
    drawStroke([v2(100, 100), v2(500, 100), v2(200, 400), v2(100, 100)]);
    api.setCursor(v2(250, 200));
    api.press('select');
    api.press('extrude');
    setHand(v2(250, 200));
    emitHands(handAt(250, 200, { pinching: true }));
    emitHands(handAt(250, 170, { pinching: true }));
    expect(api.extrusion()!.depth).toBeCloseTo(30);
    emitHands(handAt(250, 170, { pinching: false }));
    expect(api.extrusion()).not.toBeNull();
    api.press('confirm');
    expect(api.sketch.last).toMatchObject({ type: 'prism' });
    expect((api.sketch.last as { depth: number }).depth).toBeCloseTo(30);
  });

  it('selects and extrudes a loop of separately drawn lines, then cancels and commits cleanly', () => {
    drawTriangleLoop();
    const lines = [...api.sketch.all];
    expect(lines).toHaveLength(3);
    expect(api.sketch.closedLineProfiles).toHaveLength(1);
    const loop = api.sketch.closedLineProfiles[0];
    expect(api.selected()?.id).toBe(loop.id);
    const saved = api.sketch.serialize();

    api.setCursor(v2(250, 200));
    api.press('select');
    expect(api.selected()?.id).toBe(loop.id);
    api.press('extrude');
    expect(api.extrusion()).not.toBeNull();
    expect(api.extrusion()!.corners).toHaveLength(3);
    api.press('cancel');
    expect(api.extrusion()).toBeNull();
    expect(api.sketch.serialize()).toBe(saved);

    api.press('extrude');
    api.press('measure');
    h.measure.submit?.('150');
    api.press('confirm');
    expect(api.sketch.serialize()).not.toBe(saved);
    expect(api.sketch.size).toBe(1);
    expect(api.sketch.last).toMatchObject({ type: 'extrusion', depth: 150 });
    expect(api.commands.undo()).toBe('extrude 150 mm');
    expect(api.sketch.serialize()).toBe(saved);
    for (const line of lines) expect(api.sketch.get(line.id)).not.toBeUndefined();
    api.commands.redo();
    expect(api.sketch.last).toMatchObject({ type: 'extrusion', depth: 150 });
  });

  it('starts Q extrusion directly on a line that belongs to one closed loop', () => {
    api.commands.addLine(v3(100, 100, 0), v3(500, 100, 0));
    api.setCursor(v2(300, 100));
    api.press('select');
    expect(api.selected()?.type).toBe('line');
    api.commands.addLine(v3(500, 100, 0), v3(200, 400, 0));
    api.commands.addLine(v3(200, 400, 0), v3(100, 100, 0));
    api.press('extrude');
    expect(api.extrusion()).not.toBeNull();
    expect(api.extrusion()!.corners).toHaveLength(3);
    api.press('cancel');
    expect(api.sketch.size).toBe(3);
    expect(api.sketch.all.every((entity) => entity.type === 'line')).toBe(true);
  });

  it('cancels the loop preview and its voice draft when a source line is deleted', () => {
    drawTriangleLoop();
    api.setCursor(v2(250, 200));
    api.press('select');
    api.press('extrude');
    expect(api.extrusion()).not.toBeNull();
    api.hold('draw', true);
    api.setCursor(v2(250, 163));
    const target = h.voice!.capture();
    expect(h.voice!.isCurrent(target)).toBe(true);
    const lines = [...api.sketch.all];
    expect(api.commands.deleteEntity(lines[0].id).ok).toBe(true);
    expect(api.extrusion()).toBeNull();
    expect(api.sketch.closedLineProfiles).toHaveLength(0);
    expect(h.voice!.isCurrent(target)).toBe(false);
    const afterDelete = api.sketch.serialize();
    expect(h.voice!.execute({ distance_mm: 50 }, target).ok).toBe(false);
    expect(api.sketch.serialize()).toBe(afterDelete);
  });

  it('does not pick the notch of a concave outline', () => {
    drawStroke([v2(0, 0), v2(400, 0), v2(400, 100), v2(100, 100), v2(100, 300), v2(0, 300), v2(0, 0)]);
    expect(api.sketch.last?.type).toBe('polygon');
    api.setCursor(v2(250, 200));
    api.press('select');
    expect(api.selected()).toBeNull();
    api.setCursor(v2(50, 200));
    api.press('select');
    expect(api.selected()?.type).toBe('polygon');
  });

  it('commits a round stroke as a polygon ghost and never makes an open arc', () => {
    const round = Array.from({ length: 60 }, (_, i) => v2(400 + Math.cos((i / 59) * Math.PI * 2) * 200, 300 + Math.sin((i / 59) * Math.PI * 2) * 200));
    api.setCursor(round[0]);
    api.hold('draw', true);
    for (const point of round.slice(1)) api.setCursor(point);
    runFrame();
    expect(h.ghost?.closed).toBe(true);
    expect(h.ghost!.points.length).toBe(4);
    api.hold('draw', false);
    const shape = api.sketch.last;
    expect(shape?.type).toBe('rect');
    if (shape?.type === 'rect') expect(shape.corners).toHaveLength(4);
    const arc = Array.from({ length: 30 }, (_, i) => v2(400 + Math.cos((i / 29) * Math.PI * 1.4) * 200, 600 + Math.sin((i / 29) * Math.PI * 1.4) * 200));
    drawStroke(arc);
    expect(api.sketch.size).toBe(1);
  });
});

describe('voice distance', () => {
  useScreenSpaceProjector();

  const captureLine = () => {
    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    api.setCursor(v2(130, 140));
    return h.voice!.capture();
  };

  it('freezes the draft on capture, applies the spoken length on execute and selects the line', () => {
    const serialized = api.sketch.serialize();
    const target = captureLine();
    expect(target.operation.kind).toBe('line');
    api.hold('draw', false);
    api.setCursor(v2(700, 600));
    runFrame();
    expect(api.sketch.serialize()).toBe(serialized);
    const result = h.voice!.execute({ distance_mm: 500 }, target);
    expect(result.ok).toBe(true);
    const line = api.selected();
    expect(line?.type).toBe('line');
    if (line?.type === 'line') {
      expect(line.a).toEqual(v3(100, 100, 0));
      expect(line.b).toEqual(v3(400, 500, 0));
    }
    api.press('undo');
    expect(api.sketch.serialize()).toBe(serialized);
  });

  it('captures a measured line on the XZ plane', () => {
    const project = h.projector.project;
    const ray = h.projector.ray;
    h.projector.project = (point: Vec3) => v2(point.x, -point.z);
    h.projector.ray = (screen: Vec2) => ({ origin: v3(screen.x, -1000, -screen.y), dir: v3(0, 1, 0) });
    try {
      api.press('viewFront');
        api.setCursor(v2(100, -300));
      api.hold('draw', true);
      api.setCursor(v2(130, -340));
      const target = h.voice!.capture();
      api.hold('draw', false);
      const result = h.voice!.execute({ distance_mm: 500 }, target);
      expect(result.ok).toBe(true);
      const line = api.selected();
      expect(line?.type).toBe('line');
      if (line?.type === 'line') {
        expect(line.a).toEqual(v3(100, 0, 300));
        expect(line.b).toEqual(v3(400, 0, 700));
      }
    } finally {
      h.projector.project = project;
      h.projector.ray = ray;
    }
  });

  it('rejects capture with no active operation, even with a selection, and with no clear movement', () => {
    api.commands.addRect([v3(100, 100, 0), v3(500, 100, 0), v3(500, 400, 0), v3(100, 400, 0)]);
    api.setCursor(v2(250, 250));
    api.press('select');
    expect(api.selected()?.type).toBe('rect');
    expect(() => h.voice!.capture()).toThrow();

    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    expect(() => h.voice!.capture()).toThrow();
    api.hold('draw', false);
  });

  it('cancels the draft on Esc and ignores a late execute', () => {
    const target = captureLine();
    api.press('cancel');
    expect(h.voiceControl!.cancel).toHaveBeenCalledTimes(1);
    const result = h.voice!.execute({ distance_mm: 500 }, target);
    expect(result.ok).toBe(false);
    expect(api.sketch.size).toBe(0);
  });

  it('rejects the frozen operation after a programmatic model edit but keeps the new geometry', () => {
    const target = captureLine();
    api.commands.addRect([v3(0, 0, 0), v3(10, 0, 0), v3(10, 10, 0), v3(0, 10, 0)]);
    const result = h.voice!.execute({ distance_mm: 500 }, target);
    expect(result.ok).toBe(false);
    expect(api.sketch.size).toBe(1);
    expect(api.sketch.last?.type).toBe('rect');
    api.press('cancel');
    expect(api.sketch.size).toBe(1);
  });

  it('keeps the frozen draft after a failed execute so V can retry the same target', () => {
    const target = captureLine();
    api.hold('draw', false);
    const failed = h.voice!.execute({ distance_mm: -5 }, target);
    expect(failed.ok).toBe(false);
    expect(api.sketch.size).toBe(0);
    const retried = h.voice!.execute({ distance_mm: 500 }, target);
    expect(retried.ok).toBe(true);
    expect(api.sketch.last?.type).toBe('line');
    expect((api.sketch.last as { b: Vec3 }).b).toEqual(v3(400, 500, 0));
  });

  it('rejects replay of a completed target', () => {
    const target = captureLine();
    api.hold('draw', false);
    expect(h.voice!.execute({ distance_mm: 500 }, target).ok).toBe(true);
    const replay = h.voice!.execute({ distance_mm: 100 }, target);
    expect(replay.ok).toBe(false);
    expect(api.sketch.size).toBe(1);
  });

  it('V toggles the voice control once and works while extruding', () => {
    api.press('voice');
    expect(h.voiceControl!.toggle).toHaveBeenCalledTimes(1);
    startExtrusion();
    api.press('voice');
    expect(h.voiceControl!.toggle).toHaveBeenCalledTimes(2);
    api.press('cancel');
  });

  it('freezes a face pull against gestures, face cycling and other actions, then applies the spoken distance', () => {
    const serialized = startExtrusion();
    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    expect(api.extrusion()!.depth).toBe(50);
    const target = h.voice!.capture();
    api.hold('draw', false);
    api.setCursor(v2(250, 100));
    h.mouse.onMove?.(v2(400, 400));
    emitHands(handAt(300, 300, { pinching: true }));
    api.press('confirm');
    api.press('cyclePlane');
    api.hold('orbit', true);
    api.setCursor(v2(600, 500));
    runFrame();
    expect(api.extrusion()!.depth).toBe(50);
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    const result = h.voice!.execute({ distance_mm: 500 }, target);
    expect(result.ok).toBe(true);
    const solid = api.selected() as ExtrusionEntity;
    expect(solid.depth).toBe(500);
    expect(api.extrusion()).toBeNull();
    api.press('undo');
    expect(api.sketch.serialize()).toBe(serialized);
  });

  it('moves an existing solid inward by exactly the spoken distance', () => {
    api.commands.addRect([v3(100, 100, 0), v3(500, 100, 0), v3(500, 400, 0), v3(100, 400, 0)]);
    const rect = api.sketch.last as RectEntity;
    expect(api.commands.extrude(rect.id, 80).ok).toBe(true);
    const serialized = api.sketch.serialize();
    api.setCursor(v2(250, 250));
    api.press('select');
    api.press('extrude');
    api.hold('draw', true);
    api.setCursor(v2(250, 287));
    const target = h.voice!.capture();
    api.hold('draw', false);
    const result = h.voice!.execute({ distance_mm: 12.345 }, target);
    expect(result.ok).toBe(true);
    expect((api.selected() as ExtrusionEntity).depth).toBeCloseTo(80 - 12.345, 9);
    api.press('undo');
    expect(api.sketch.serialize()).toBe(serialized);
  });

  it('measures a face pull from the current grab baseline', () => {
    startExtrusion();
    api.hold('draw', true);
    api.setCursor(v2(250, 230));
    expect(api.extrusion()!.depth).toBe(20);
    api.hold('draw', false);
    api.hold('draw', true);
    api.setCursor(v2(400, 193));
    expect(api.extrusion()!.depth).toBe(57);
    const target = h.voice!.capture();
    api.hold('draw', false);
    const result = h.voice!.execute({ distance_mm: 10 }, target);
    expect(result.ok).toBe(true);
    expect((api.selected() as ExtrusionEntity).depth).toBeCloseTo(30, 9);
  });

  it('freezes the cursor glyph and blocks wheel zoom while a voice draft is pending', () => {
    captureLine();
    runFrame();
    const frozen = h.glyph.update.mock.calls.at(-1);
    api.setCursor(v2(700, 600));
    h.mouse.onWheel?.(1.15, v2(700, 600));
    runFrame();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
    expect(h.glyph.update.mock.calls.at(-1)).toEqual(frozen);
    api.press('cancel');
    api.press('cancel');
    h.mouse.onWheel?.(1.15, v2(700, 600));
    expect(h.orbit.zoom).toHaveBeenCalled();
  });

  it('blocks wheel zoom while a face pull voice draft is pending', () => {
    startExtrusion();
    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    const target = h.voice!.capture();
    h.mouse.onWheel?.(1.15, v2(400, 400));
    runFrame();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
    api.hold('draw', false);
    expect(h.voice!.execute({ distance_mm: 100 }, target).ok).toBe(true);
    h.mouse.onWheel?.(1.15, v2(400, 400));
    expect(h.orbit.zoom).toHaveBeenCalled();
  });

  it('rejects the frozen operation after undo restores the prior geometry', () => {
    const serialized = api.sketch.serialize();
    const target = captureLine();
    api.commands.addRect([v3(0, 0, 0), v3(10, 0, 0), v3(10, 10, 0), v3(0, 10, 0)]);
    api.commands.undo();
    expect(api.sketch.serialize()).toBe(serialized);
    expect(h.voice!.isCurrent(target)).toBe(false);
    expect(h.voice!.execute({ distance_mm: 500 }, target).ok).toBe(false);
    expect(api.sketch.serialize()).toBe(serialized);
  });

  it('a fresh capture after cancel commits while the cancelled target stays rejected', () => {
    const staleTarget = captureLine();
    api.press('cancel');
    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    api.setCursor(v2(130, 140));
    const target = h.voice!.capture();
    api.hold('draw', false);
    expect(h.voice!.execute({ distance_mm: 500 }, staleTarget).ok).toBe(false);
    expect(h.voice!.execute({ distance_mm: 500 }, target).ok).toBe(true);
    const line = api.sketch.last;
    expect(line?.type).toBe('line');
    if (line?.type === 'line') expect(line.b).toEqual(v3(400, 500, 0));
  });

  it('captures a measured line on the YZ plane', () => {
    const project = h.projector.project;
    const ray = h.projector.ray;
    h.projector.project = (point: Vec3) => v2(point.y, -point.z);
    h.projector.ray = (screen: Vec2) => ({ origin: v3(-1000, screen.x, -screen.y), dir: v3(1, 0, 0) });
    try {
      api.press('viewRight');
        api.setCursor(v2(200, -300));
      api.hold('draw', true);
      api.setCursor(v2(230, -340));
      const target = h.voice!.capture();
      api.hold('draw', false);
      const result = h.voice!.execute({ distance_mm: 500 }, target);
      expect(result.ok).toBe(true);
      const line = api.selected();
      expect(line?.type).toBe('line');
      if (line?.type === 'line') {
        expect(line.a).toEqual(v3(0, 200, 300));
        expect(line.b).toEqual(v3(0, 500, 700));
      }
    } finally {
      h.projector.project = project;
      h.projector.ray = ray;
    }
  });

  it('still commits an ordinary stroke on release when voice was never used', () => {
    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    api.setCursor(v2(150, 100));
    api.hold('draw', false);
    const line = api.sketch.last;
    expect(line?.type).toBe('line');
    if (line?.type === 'line') expect(line.b).toEqual(v3(150, 100, 0));
  });

  it('shows the refined voice direction before capture and commits exactly that frozen guide', () => {
    const before = api.sketch.serialize();
    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    api.setCursor(v2(112, 117));
    for (let i = 1; i <= 16; i += 1) api.setCursor(v2(100 + 3 * (i + 10), 100 + 4 * (i + 10)));
    runFrame();
    const [points, label] = h.guide.mock.calls.at(-1)! as [Vec3[], { text: string }];
    const direction = normalize(sub(points[1], points[0]));
    expect(label.text).toContain('Voice aim');
    expect(direction.x).toBeCloseTo(0.6, 9);
    expect(direction.y).toBeCloseTo(0.8, 9);
    const target = h.voice!.capture();
    if (target.operation.kind !== 'line') throw new Error('expected line');
    expect(distance(direction, target.operation.measurement.direction)).toBeLessThan(1e-9);
    api.hold('draw', false);
    api.setCursor(v2(800, 200));
    runFrame();
    expect(h.guide.mock.calls.at(-1)![0]).toEqual(points);
    expect(h.guide.mock.calls.at(-1)![1].text).toContain('Voice direction locked');
    expect(h.voice!.isCurrent(target)).toBe(true);
    expect(h.voice!.execute({ distance_mm: 5000 }, target).ok).toBe(true);
    const line = api.sketch.last;
    if (line?.type !== 'line') throw new Error('expected line');
    expect(distance(line.a, line.b)).toBeCloseTo(5000, 9);
    expect(distance(line.b, add(line.a, scale(direction, 5000)))).toBeLessThan(1e-9);
    expect(h.guide).toHaveBeenLastCalledWith(null, null);
    api.press('undo');
    expect(api.sketch.serialize()).toBe(before);
  });

  it('allows an explicit axis lock after aiming without another cursor move', () => {
    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    api.setCursor(v2(160, 125));
    api.hold('lockX', true);
    runFrame();
    const points = h.guide.mock.calls.at(-1)![0] as Vec3[];
    expect(normalize(sub(points[1], points[0]))).toEqual(v3(1, 0, 0));
    const target = h.voice!.capture();
    expect(h.voice!.execute({ distance_mm: 5000 }, target).ok).toBe(true);
    const line = api.sketch.last;
    if (line?.type !== 'line') throw new Error('expected line');
    expect(line.b).toEqual(v3(5100, 100, 0));
  });

  it('shows and freezes the same free-angle guide for tracked-hand drawing', () => {
    emitHands(handAt(100, 100));
    api.hold('draw', true);
    for (let i = 1; i <= 24; i += 1) {
      h.nowMs += 33;
      emitHands(handAt(100 + 6 * i, 100 + 8 * i + (i % 2 ? 2 : -2)));
    }
    runFrame();
    const points = h.guide.mock.calls.at(-1)![0] as Vec3[];
    const direction = normalize(sub(points[1], points[0]));
    expect(Math.abs(direction.x - 0.6)).toBeLessThan(0.04);
    expect(Math.abs(direction.y - 0.8)).toBeLessThan(0.04);
    const target = h.voice!.capture();
    h.nowMs += 33;
    emitHands(handAt(800, 100));
    runFrame();
    expect(h.guide.mock.calls.at(-1)![0]).toEqual(points);
    expect(h.voice!.isCurrent(target)).toBe(true);
    api.press('cancel');
    expect(h.guide).toHaveBeenLastCalledWith(null, null);
    expect(api.sketch.size).toBe(0);
  });

  it('clears the voice guide when a rectangle is recognized or an ordinary stroke finishes', () => {
    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    api.setCursor(v2(200, 100));
    runFrame();
    expect(h.guide.mock.calls.at(-1)![0]).not.toBeNull();
    for (const point of [v2(200, 200), v2(100, 200), v2(100, 100)]) api.setCursor(point);
    runFrame();
    expect(h.guide).toHaveBeenLastCalledWith(null, null);
    api.hold('draw', false);
    expect(api.sketch.last?.type).toBe('rect');
    expect(h.guide).toHaveBeenLastCalledWith(null, null);
  });
});
describe('parallel edge guides', () => {
  function setupParallelScene(): { refId: string; px: number; gap: number } {
    const added = api.commands.addLine(v3(0, 0, 0), v3(4000, 0, 0));
    if (!added.ok) throw new Error(added.error);
    api.press('viewTop');
    api.press('fitAll');
    finishTransitions();
    setGrid(false);
    const px = Math.abs(api.project(v3(1, 0, 0))!.x - api.project(v3(0, 0, 0))!.x);
    return { refId: added.entity.id, px, gap: 70 / px };
  }

  it('previews and commits an equal-length line parallel to a nearby side', () => {
    const { refId, px, gap } = setupParallelScene();
    setCursorWorld(v3(0, gap, 0));
    api.hold('draw', true);
    setCursorWorld(v3(2000, gap, 0));
    setCursorWorld(v3(4000 - 5 / px, gap + 2 / px, 0));
    tick();
    const guide = state.renderer.guide;
    expect(guide?.matchedLength).toBe(true);
    expect(guide?.reference.entityId).toBe(refId);
    const ghost = state.renderer.ghost;
    expect(ghost).not.toBeNull();
    const previewEnd = ghost!.points[ghost!.points.length - 1];
    expect(previewEnd.x).toBeCloseTo(4000, 5);
    expect(previewEnd.y).toBeCloseTo(gap, 5);
    expect(previewEnd.z).toBeCloseTo(0, 5);
    api.hold('draw', false);
    expect(api.sketch.size).toBe(2);
    expect(state.renderer.guide).toBeNull();
    const line = api.sketch.all[1];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.a).toEqual(ghost!.points[0]);
      expect(line.b).toEqual(previewEnd);
    }
    const ref = api.sketch.all[0];
    expect(ref.id).toBe(refId);
    if (ref.type === 'line') {
      expect(ref.a).toEqual(v3(0, 0, 0));
      expect(ref.b).toEqual(v3(4000, 0, 0));
    }
    api.commands.undo();
    expect(api.sketch.size).toBe(1);
    api.commands.redo();
    expect(api.sketch.size).toBe(2);
    expect(api.sketch.all[1]).toEqual(line);
  });

  it('previews and commits the same correction for a depth-drawn stroke', () => {
    const { refId, px, gap } = setupParallelScene();
    enablePlanarDepth();
    api.pushSpatial(spatialAt(v3(0, gap, 0)));
    api.hold('draw', true);
    tick();
    api.pushSpatial(spatialAt(v3(2000, gap, 0)));
    tick();
    api.pushSpatial(spatialAt(v3(4000 - 5 / px, gap + 2 / px, 0)));
    tick();
    const guide = state.renderer.guide;
    expect(guide?.matchedLength).toBe(true);
    expect(guide?.reference.entityId).toBe(refId);
    const ghost = state.renderer.ghost;
    expect(ghost).not.toBeNull();
    const previewEnd = ghost!.points[ghost!.points.length - 1];
    expect(previewEnd.x).toBeCloseTo(4000, 3);
    expect(previewEnd.y).toBeCloseTo(gap, 3);
    api.hold('draw', false);
    expect(api.sketch.size).toBe(2);
    const line = api.sketch.all[1];
    expect(line.type).toBe('line');
    if (line.type === 'line') {
      expect(line.b.x).toBeCloseTo(4000, 3);
      expect(line.b.y).toBeCloseTo(gap, 3);
    }
    expect(state.renderer.guide).toBeNull();
    expect(state.measure.isOpen).toBe(false);
  });

  it('shows a length-only suggestion for a shorter side and clears it on cancel', () => {
    const { refId, px, gap } = setupParallelScene();
    setCursorWorld(v3(0, gap, 0));
    api.hold('draw', true);
    setCursorWorld(v3(1200, gap, 0));
    setCursorWorld(v3(2400 - 5 / px, gap + 2 / px, 0));
    tick();
    const guide = state.renderer.guide;
    expect(guide).not.toBeNull();
    expect(guide!.matchedLength).toBe(false);
    expect(guide!.reference.entityId).toBe(refId);
    expect(guide!.target.x).toBeCloseTo(4000, 3);
    const size = api.sketch.size;
    api.press('cancel');
    expect(state.renderer.guide).toBeNull();
    expect(state.renderer.ghost).toBeNull();
    expect(api.sketch.size).toBe(size);
  });

  it('drops the guide when the endpoint leaves the guide band', () => {
    const { px, gap } = setupParallelScene();
    setCursorWorld(v3(0, gap, 0));
    api.hold('draw', true);
    setCursorWorld(v3(2000, gap, 0));
    tick();
    expect(state.renderer.guide).not.toBeNull();
    setCursorWorld(v3(2000, gap + 90 / px, 0));
    tick();
    expect(state.renderer.guide).toBeNull();
    api.hold('draw', false);
    expect(api.sketch.size).toBe(1);
  });

  it('guides the last leg of an unfinished outline without touching its raw first side', () => {
    const added = api.commands.addLine(v3(0, 0, 0), v3(0, 4000, 0));
    if (!added.ok) throw new Error(added.error);
    api.press('viewTop');
    api.press('fitAll');
    finishTransitions();
    setGrid(false);
    const px = Math.abs(api.project(v3(1, 0, 0))!.x - api.project(v3(0, 0, 0))!.x);
    const gap = 70 / px;
    setCursorWorld(v3(gap + 2000, -400, 0));
    api.hold('draw', true);
    setCursorWorld(v3(gap, -400, 0));
    tick();
    expect(state.renderer.guide).toBeNull();
    setCursorWorld(v3(gap, 3600 - 5 / px, 0));
    tick();
    const guide = state.renderer.guide;
    expect(guide).not.toBeNull();
    expect(guide!.matchedLength).toBe(true);
    expect(guide!.reference.entityId).toBe(added.entity.id);
    expect(guide!.start.x).toBeCloseTo(gap, 3);
    expect(guide!.start.y).toBeCloseTo(-400, 3);
    expect(guide!.target.x).toBeCloseTo(gap, 3);
    expect(guide!.target.y).toBeCloseTo(3600, 3);
    api.press('cancel');
    expect(state.renderer.guide).toBeNull();
    expect(api.sketch.size).toBe(1);
  });
});

describe('presentation and display style', () => {
  const seedHouse = (): string => {
    const body = api.commands.addRect([v3(0, 0, 0), v3(4000, 0, 0), v3(4000, 3000, 0), v3(0, 3000, 0)]);
    if (!body.ok) throw new Error(body.error);
    const extruded = api.commands.extrude(body.entity.id, 2500);
    if (!extruded.ok) throw new Error(extruded.error);
    return api.sketch.serialize();
  };

  it('rejects Reveal on an empty sketch', () => {
    api.press('reveal');
    expect(state.shell.presenting).toBe(false);
    expect(state.toasts.at(-1)).toBe(EMPTY_PRESENTATION);
  });

  it('enters and exits Reveal without mutating the model, history, or a pinned plane', () => {
    const serialized = seedHouse();
    api.press('viewFront');
    expect(api.planeMode()).toBe('manual');
    expect(api.plane().kind).toBe('XZ');
    const selected = api.selected()?.id ?? null;
    api.press('reveal');
    expect(state.shell.presenting).toBe(true);
    expect(state.renderer.displayStyle).toBe('shaded');
    expect(state.renderer.presentation).toBe(true);
    expect(api.sketch.serialize()).toBe(serialized);
    expect(api.sketch.canUndo).toBe(true);
    expect(api.selected()?.id ?? null).toBe(selected);
    api.press('viewTop');
    expect(api.plane().kind).toBe('XZ');
    expect(api.planeMode()).toBe('manual');
    api.press('delete');
    expect(api.sketch.serialize()).toBe(serialized);
    expect(state.toasts.at(-1)).toBe(PRESENTING_FIRST);
    api.press('cancel');
    expect(state.shell.presenting).toBe(false);
    expect(state.renderer.displayStyle).toBe('xray');
    expect(state.renderer.presentation).toBe(false);
    expect(api.sketch.serialize()).toBe(serialized);
    expect(api.plane().kind).toBe('XZ');
    expect(api.planeMode()).toBe('manual');
    expect(api.selected()?.id ?? null).toBe(selected);
  });

  it('restores the previous display style after Reveal', () => {
    seedHouse();
    expect(state.commands.dispatch({ type: 'setDisplayStyle', style: 'shaded' }).ok).toBe(true);
    api.press('reveal');
    api.press('reveal');
    expect(state.renderer.displayStyle).toBe('shaded');
    expect(state.shell.presenting).toBe(false);
  });

  it('blocks typed workspace actions while presenting', () => {
    seedHouse();
    api.press('reveal');
    const serialized = api.sketch.serialize();
    expect(state.commands.dispatch({ type: 'press', action: 'undo' })).toEqual({ ok: false, error: PRESENTING_FIRST });
    expect(state.commands.dispatch({ type: 'setDisplayStyle', style: 'xray' })).toEqual({ ok: false, error: PRESENTING_FIRST });
    expect(api.sketch.serialize()).toBe(serialized);
    api.press('reveal');
  });

  it('ignores draw holds and pinch selection while presenting', () => {
    seedHouse();
    api.press('reveal');
    const size = api.sketch.size;
    api.hold('draw', true);
    setCursorWorld(v3(100, 100, 0));
    api.hold('draw', false);
    expect(api.sketch.size).toBe(size);
    emitHands(handAt(250, 250, { pinching: true }));
    expect(api.selected()).toBeNull();
    api.press('reveal');
    emitHands(handAt(250, 250, { pinching: true }));
    expect(api.selected()).toBeNull();
    expect(api.sketch.size).toBe(size);
  });

  it('preserves a live stroke when a preserve-draft control is focused', () => {
    dispatchWindow('focus', {});
    setCursorWorld(v3(0, 0, 0));
    api.hold('draw', true);
    setCursorWorld(v3(4000, 0, 0));
    const preserve = {
      target: {
        closest: (selector: string) => (selector === '[data-cad-preserve-draft]' || selector === '[data-cad-ui]' ? {} : null),
      },
    };
    appRoot.dispatch('pointerdown', preserve);
    api.hold('draw', false);
    expect(api.sketch.size).toBe(1);
  });

  it('still cancels a live stroke when ordinary chrome is focused', () => {
    dispatchWindow('focus', {});
    setCursorWorld(v3(0, 0, 0));
    api.hold('draw', true);
    setCursorWorld(v3(4000, 0, 0));
    appRoot.dispatch('pointerdown', {
      target: { closest: (selector: string) => (selector === '[data-cad-ui]' ? {} : null) },
    });
    api.hold('draw', false);
    expect(api.sketch.size).toBe(0);
  });
});

describe('presentation (Reveal)', () => {
  const dispatch = (action: unknown): { ok: boolean; error?: string } =>
    (state.commands as { dispatch: (a: unknown) => { ok: boolean; error?: string } }).dispatch(action);

  const seedRect = (): void => {
    const added = api.commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    if (!added.ok) throw new Error(added.error);
  };

  const presentingNow = (): boolean => {
    runFrame();
    return (state.hud?.last as { presentation?: boolean } | null)?.presentation === true;
  };

  it('does nothing on an empty sketch or while a stroke is active', () => {
    api.press('reveal');
    expect(presentingNow()).toBe(false);
    expect(state.toasts.at(-1)).toContain('Draw something');

    seedRect();
    // Draw well clear of the seeded rectangle so the stroke commits as a line.
    setCursorWorld(v3(500, 4000, 0));
    api.hold('draw', true);
    setCursorWorld(v3(2500, 4000, 0));
    api.press('reveal');
    expect(presentingNow()).toBe(false);
    expect(state.toasts.at(-1)).toContain('stroke');
    // Releasing the pen still commits the original draft.
    api.hold('draw', false);
    expect(api.sketch.size).toBe(2);
    expect(api.sketch.all[1].type).toBe('line');
  });

  it('is blocked while a voice request is in flight or a dialog is open', () => {
    seedRect();
    state.voiceControl!.busy = true;
    api.press('reveal');
    expect(presentingNow()).toBe(false);
    expect(state.toasts.at(-1)).toContain('voice');
    state.voiceControl!.busy = false;

    state.help.visible = true;
    api.press('reveal');
    expect(presentingNow()).toBe(false);
    expect(state.toasts.at(-1)).toContain('dialog');
    state.help.visible = false;
  });

  it('enters Shaded + orthographic fit and hides helpers without touching the model', () => {
    seedRect();
    const serialized = api.sketch.serialize();
    expect(state.viewport.ortho).toBe(false);
    api.press('reveal');
    expect(presentingNow()).toBe(true);
    expect(state.shell.presentation).toBe(true);
    expect(state.renderer.presentation).toBe(true);
    expect(state.renderer.displayStyle).toBe('shaded');
    expect(state.viewport.ortho).toBe(true);
    expect(api.sketch.serialize()).toEqual(serialized);
    expect(state.glyph.update).toHaveBeenCalledWith(null, null, false);
    api.press('cancel');
  });

  it('blocks every editing action but keeps navigation live without pinning the plane', () => {
    seedRect();
    const id = api.sketch.all[0].id;
    expect(dispatch({ type: 'selectEntity', id }).ok).toBe(true);
    const serialized = api.sketch.serialize();
    api.press('reveal');
    expect(presentingNow()).toBe(true);
    const planeBefore = api.plane().kind;

    for (const action of [
      'select', 'move', 'scale', 'extrude', 'confirm', 'measure', 'voice', 'export',
      'undo', 'redo', 'delete', 'clear', 'cyclePlane', 'toggleAutoPlane', 'toggleGrid',
      'togglePip', 'toggleNavAssist', 'help', 'setOrigin', 'recenter',
    ] as const) {
      api.press(action);
    }
    api.hold('draw', true);
    api.setCursor(v2(300, 300));
    api.hold('draw', false);
    emitHands(handAt(200, 150, { pinching: true }));
    emitHands(emptyHands());
    for (const action of [
      { type: 'selectEntity', id },
      { type: 'setWorkPlane', plane: 'xz' },
      { type: 'setDisplayStyle', style: 'xray' },
    ]) {
      expect(dispatch(action)).toEqual({ ok: false, error: 'Return to editing first (D or Esc).' });
    }
    expect(state.toasts.some((message) => message.includes('Return to editing first'))).toBe(true);

    expect(api.sketch.serialize()).toEqual(serialized);
    expect(api.selected()?.id).toBe(id);
    expect(api.sketch.canUndo).toBe(true);
    expect(api.sketch.canRedo).toBe(false);
    expect(api.planeMode()).toBe('auto');
    expect(api.plane().kind).toBe(planeBefore);

    // Camera navigation stays live and never pins the plane.
    api.press('viewTop');
    api.press('viewFront');
    api.press('viewRight');
    api.press('viewIso');
    api.press('fitAll');
    api.press('zoomIn');
    api.press('zoomOut');
    api.press('toggleProjection');
    api.press('toggleProjection');
    api.hold('orbit', true);
    api.setCursor(v2(320, 260));
    api.hold('orbit', false);
    expect(api.plane().kind).toBe(planeBefore);
    expect(api.planeMode()).toBe('auto');
    expect(api.sketch.serialize()).toEqual(serialized);
    api.press('cancel');
  });

  it('restores style, projection, selection and history on exit without an extra undo step', () => {
    seedRect();
    const id = api.sketch.all[0].id;
    dispatch({ type: 'selectEntity', id });
    dispatch({ type: 'setDisplayStyle', style: 'shaded' });
    expect(state.renderer.displayStyle).toBe('shaded');
    const serialized = api.sketch.serialize();

    api.press('reveal');
    expect(presentingNow()).toBe(true);
    expect(state.viewport.ortho).toBe(true);

    api.press('cancel');
    expect(presentingNow()).toBe(false);
    expect(state.shell.presentation).toBe(false);
    expect(state.renderer.presentation).toBe(false);
    expect(state.renderer.displayStyle).toBe('shaded');
    expect(state.viewport.ortho).toBe(false);
    expect(api.selected()?.id).toBe(id);
    expect(api.sketch.serialize()).toEqual(serialized);
    expect(api.commands.undo()).toBe('add rect');
    expect(api.sketch.size).toBe(0);
  });

  it('exits through D and Escape even from the view-control strip, while Tab stays native', () => {
    seedRect();
    api.press('reveal');
    expect(presentingNow()).toBe(true);

    // Tab is not on the presentation allowlist, so it must not be intercepted.
    const tab = keyEvent('Tab', { preventDefault: vi.fn() });
    dispatchWindow('keydown', tab);
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(api.plane().kind).toBe('XY');
    expect(presentingNow()).toBe(true);

    // Focus on the non-editable view strip still honours D and Escape.
    const chromeTarget = { closest: (selector: string) => (selector === '[data-cad-ui]' ? {} : null) };
    dispatchWindow('keydown', keyEvent('KeyD', { target: chromeTarget }));
    expect(presentingNow()).toBe(false);

    api.press('reveal');
    expect(presentingNow()).toBe(true);
    dispatchWindow('keydown', keyEvent('Escape', { target: chromeTarget }));
    expect(presentingNow()).toBe(false);
  });

  it('cannot synthesize a selection from a pinch held across the exit', () => {
    seedRect();
    api.press('reveal');
    expect(presentingNow()).toBe(true);
    emitHands(handAt(200, 150, { pinching: true }));
    emitHands(handAt(200, 150, { pinching: true }));
    api.press('reveal');
    expect(presentingNow()).toBe(false);
    // The pinch stays held through the exit: no fresh pinch edge, no selection.
    emitHands(handAt(200, 150, { pinching: true }));
    emitHands(emptyHands());
    expect(api.selected()).toBeNull();
    expect(api.sketch.size).toBe(1);
  });

  it('commits nothing when a draw hold was blocked in Reveal and released after exit', () => {
    seedRect();
    api.press('reveal');
    api.hold('draw', true);
    api.setCursor(v2(200, 200));
    api.press('reveal');
    api.hold('draw', false);
    api.setCursor(v2(400, 400));
    expect(api.sketch.size).toBe(1);
  });
});
