import { OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandsMessage, NavMessage, TrackedHandMessage } from './input/tracker-client';
import type { AirCadApi } from './main';
import { makeRect, type Entity } from './model/sketch';
import { circleStroke, rectStroke, triangleStroke } from './model/test-helpers';
import { v2, v3, type Vec2, type Vec3 } from './model/vec';

const h = vi.hoisted(() => ({
  projector: {
    project: (point: Vec3): Vec2 => ({ x: point.x, y: point.y - point.z }),
    ray: (point: Vec2): { origin: Vec3; dir: Vec3 } => ({
      origin: { x: point.x, y: point.y, z: 1000 },
      dir: { x: 0, y: 0, z: -1 },
    }),
  },
  orbit: {
    orbit: vi.fn(),
    pan: vi.fn(),
    zoom: vi.fn(),
    fit: vi.fn(),
    setView: vi.fn(),
    toggleProjection: vi.fn(() => true),
    worldPerPixel: vi.fn(() => 1),
    beginOrbit: vi.fn(),
    endOrbit: vi.fn(() => null),
    cancelTransition: vi.fn(),
    update: vi.fn(),
    transitioning: false,
  },
  tracker: {} as {
    onHands?: (message: HandsMessage) => void;
    onThumb?: (message: unknown) => void;
    onStatus?: (message: unknown) => void;
    onConnection?: (state: string) => void;
  },
  mouse: {} as {
    onMove?: (point: Vec2) => void;
    onHold?: (action: 'draw' | 'orbit' | 'pan', down: boolean) => void;
    onWheel?: (deltaY: number, point: Vec2) => void;
  },
  listeners: new Map<string, ((event: unknown) => void)[]>(),
  hudStates: [] as { mode: string }[],
  hudKeys: [] as { key: string; label: string }[][],
  toasts: [] as string[],
  renderer: {
    extrusions: [] as unknown[],
    activeFaces: [] as unknown[],
    sketches: [] as (readonly Entity[])[],
    ghosts: [] as { points: readonly Vec3[] | null; label: { text: string; at: Vec3 } | null }[],
    ghostClosed: [] as boolean[],
  },
  viewDirection: { x: 0, y: 0, z: -1 } as Vec3,
  resizeCallbacks: [] as (() => void)[],
  help: { visible: false },
  measure: { isOpen: false, submit: null as null | ((text: string) => void) },
  raf: null as null | ((time: number) => void),
  nowMs: 10_000,
}));

vi.mock('./scene/viewport', () => ({
  Viewport: class {
    readonly width = 1000;
    readonly height = 800;
    ortho = false;
    readonly scene = { add: (_object: unknown) => {} };
    constructor(readonly container: unknown) {}
    onResize(cb: () => void): () => void {
      h.resizeCallbacks.push(cb);
      return () => {};
    }
    render(): void {}
    viewDirection(): Vec3 {
      return h.viewDirection;
    }
    projector() {
      return h.projector;
    }
  },
}));

vi.mock('./scene/orbit', () => ({
  OrbitController: class {
    readonly orbit = h.orbit.orbit;
    readonly pan = h.orbit.pan;
    readonly zoom = h.orbit.zoom;
    readonly fit = h.orbit.fit;
    readonly setView = h.orbit.setView;
    readonly toggleProjection = h.orbit.toggleProjection;
    readonly worldPerPixel = h.orbit.worldPerPixel;
    readonly beginOrbit = h.orbit.beginOrbit;
    readonly endOrbit = h.orbit.endOrbit;
    readonly cancelTransition = h.orbit.cancelTransition;
    readonly update = h.orbit.update;
    transitioning = false;
    constructor(_viewport: unknown) {}
    onChange(): () => void {
      return () => {};
    }
  },
}));

vi.mock('./scene/grid', () => ({
  AxisTriad: class {
    render(): void {}
  },
  createGroundGrid: () => ({}),
}));

vi.mock('./scene/workplane-visual', () => ({
  WorkPlaneVisual: class {
    readonly group = {};
    update(): void {}
    setVisible(): void {}
  },
}));

vi.mock('./scene/spatial-cursor-visual', () => ({
  SpatialCursorVisual: class {
    readonly group = {};
    update(): void {}
  },
}));

vi.mock('./ui/input-panel', () => ({
  InputPanel: class {
    constructor(_root: unknown, _handlers: unknown) {}
    update(): void {}
  },
}));

vi.mock('./render/sketch-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./render/sketch-renderer')>()),
  SketchRenderer: class {
    constructor(_viewport: unknown) {}
    setSketch(entities: readonly Entity[]): void {
      h.renderer.sketches.push([...entities]);
    }
    setSelected(): void {}
    setHover(): void {}
    setVisible(): void {}
    setExtrusion(entity: unknown): void {
      if (entity) h.renderer.extrusions.push(entity);
    }
    setActiveFace(face: unknown): void {
      if (face) h.renderer.activeFaces.push(face);
    }
    setLastLabel(): void {}
    setGhost(points: readonly Vec3[] | null, closed: boolean, label: { text: string; at: Vec3 } | null): void {
      h.renderer.ghosts.push({ points, label });
      h.renderer.ghostClosed.push(closed);
    }
    setInk(): void {}
    setEdgeGuide(): void {}
    fadeOut(): void {}
    tick(): void {}
  },
}));

vi.mock('./ui/hud', () => ({
  Hud: class {
    constructor(_root: unknown) {}
    update(state: { mode: string }): void {
      h.hudStates.push(state);
    }
    setKeys(keys: { key: string; label: string }[]): void {
      h.hudKeys.push(keys);
    }
  },
}));

vi.mock('./ui/cursor-glyph', () => ({
  CursorGlyph: class {
    constructor(_root: unknown) {}
    update(): void {}
  },
}));

vi.mock('./ui/toast', () => ({
  Toasts: class {
    constructor(_root: unknown) {}
    show(message: string): void {
      h.toasts.push(message);
    }
  },
}));

vi.mock('./ui/pip', () => ({
  CameraPip: class {
    constructor(_root: unknown) {}
    setThumb(): void {}
    setHands(): void {}
    setCameraState(): void {}
    setSpatial(): void {}
    setStream(): void {}
    toggle(): boolean {
      return false;
    }
  },
}));

vi.mock('./ui/measure-input', () => ({
  MeasureInput: class {
    constructor(_root: unknown) {}
    get isOpen(): boolean {
      return h.measure.isOpen;
    }
    open(_label: string, onSubmit: (text: string) => void): void {
      h.measure.isOpen = true;
      h.measure.submit = onSubmit;
    }
    close(): void {
      h.measure.isOpen = false;
      h.measure.submit = null;
    }
  },
}));

vi.mock('./ui/help', () => ({
  HelpOverlay: class {
    constructor(_root: unknown, _platform: unknown) {}
    get visible(): boolean {
      return h.help.visible;
    }
    show(): void {
      h.help.visible = true;
    }
    hide(): void {
      h.help.visible = false;
    }
    toggle(): void {
      h.help.visible = !h.help.visible;
    }
  },
}));

vi.mock('./input/tracker-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./input/tracker-client')>();
  return {
    ...actual,
    defaultTrackerUrl: () => 'ws://mock/ws',
    TrackerClient: class {
      state = 'closed';
      lastStatus = null;
      constructor(
        readonly url: string,
        handlers: typeof h.tracker,
      ) {
        h.tracker = handlers;
      }
      connect(): void {}
      close(): void {}
    },
  };
});

vi.mock('./input/mouse-source', () => ({
  MouseSource: class {
    constructor(_element: unknown, handlers: typeof h.mouse) {
      h.mouse = handlers;
    }
    releaseAll(): void {}
    dispose(): void {}
  },
}));

let api: AirCadApi;

const fire = (type: string, event?: unknown): void => {
  for (const listener of h.listeners.get(type) ?? []) listener(event);
};

const runFrame = (): void => {
  const cb = h.raf;
  h.raf = null;
  cb?.(h.nowMs);
};

const FRAME = { w: 640, h: 480 };

function tipFor(px: number, py: number): [number, number] {
  return [FRAME.w * 0.12 + (px / 1000) * FRAME.w * 0.76, FRAME.h * 0.12 + (py / 800) * FRAME.h * 0.76];
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
  return { type: 'hands', t: h.nowMs / 1000, frame: { ...FRAME }, hands: [hand], nav };
}

const emitHands = (message: HandsMessage): void => h.tracker.onHands?.(message);
const emitEmptyHands = (): void => h.tracker.onHands?.({ type: 'hands', t: 0, frame: { ...FRAME }, hands: [], nav: null });
const setHand = (p: Vec2): void => emitHands(handAt(p.x, p.y));

function startExtrusion(setCursor: (p: Vec2) => void = (p) => api.setCursor(p)): string {
  api.commands.addRect([v3(100, 100, 0), v3(500, 100, 0), v3(500, 400, 0), v3(100, 400, 0)]);
  const serialized = api.sketch.serialize();
  setCursor(v2(250, 250));
  api.press('select');
  api.press('toggleGrid');
  api.press('extrude');
  return serialized;
}

beforeEach(async () => {
  vi.resetModules();
  h.tracker = {};
  h.mouse = {};
  h.listeners = new Map();
  h.hudStates = [];
  h.hudKeys = [];
  h.toasts = [];
  h.renderer.extrusions = [];
  h.renderer.activeFaces = [];
  h.renderer.sketches = [];
  h.renderer.ghosts = [];
  h.renderer.ghostClosed = [];
  h.viewDirection = { x: 0, y: 0, z: -1 };
  h.resizeCallbacks = [];
  h.help.visible = false;
  h.measure.isOpen = false;
  h.measure.submit = null;
  h.raf = null;
  h.nowMs = 10_000;
  vi.clearAllMocks();
  const windowStub = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const list = h.listeners.get(type) ?? [];
      list.push(listener);
      h.listeners.set(type, list);
    },
    location: { protocol: 'http:', host: 'aircad.test' },
  };
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === 'app' ? { appendChild: () => {}, append: () => {} } : null),
    createElement: () => ({ className: '', tabIndex: 0, style: {}, focus: () => {} }),
  });
  vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
    h.raf = cb;
    return 1;
  });
  vi.stubGlobal('performance', { now: () => h.nowMs });
  await import('./main');
  api = (windowStub as { aircad?: AirCadApi }).aircad!;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('camera navigation during push/pull', () => {
  it.each(['orbit', 'pan'] as const)('%s overrides an active mouse/Space pull and resumes without a depth jump', (nav) => {
    const serialized = startExtrusion();
    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    expect(api.extrusion()).toMatchObject({ depth: 50, dragging: true });
    const preview = structuredClone(api.extrusion()!);
    const spy = nav === 'orbit' ? h.orbit.orbit : h.orbit.pan;
    const other = nav === 'orbit' ? h.orbit.pan : h.orbit.orbit;

    api.hold(nav, true);
    api.setCursor(v2(300, 150));
    if (nav === 'orbit') expect(spy).toHaveBeenCalledWith(50, -50, v3(300, 250, 0));
    else expect(spy).toHaveBeenCalledWith(50, -50);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    const frozen = api.extrusion()!;
    expect(frozen.depth).toBe(preview.depth);
    expect(frozen.corners).toEqual(preview.corners);
    expect(frozen.face).toBe(preview.face);
    expect(frozen.dragging).toBe(false);
    expect(api.sketch.serialize()).toBe(serialized);

    api.hold(nav, false);
    expect(api.extrusion()!.depth).toBe(50);
    expect(api.extrusion()!.dragging).toBe(true);
    api.setCursor(v2(300, 140));
    expect(api.extrusion()!.depth).toBe(60);

    api.press('confirm');
    expect(api.sketch.serialize()).not.toBe(serialized);
    api.press('undo');
    expect(api.sketch.serialize()).toBe(serialized);
    expect(api.commands.undo()).toBe('add rect');
    expect(api.sketch.size).toBe(0);
  });

  it.each(['orbit', 'pan'] as const)('%s overrides an active hand pinch and resumes without a depth jump', (nav) => {
    const serialized = startExtrusion(setHand);
    emitHands(handAt(250, 250, { pinching: true }));
    emitHands(handAt(250, 200, { pinching: true }));
    expect(api.extrusion()!.depth).toBeCloseTo(50);
    expect(api.extrusion()!.dragging).toBe(true);
    const preview = structuredClone(api.extrusion()!);
    const spy = nav === 'orbit' ? h.orbit.orbit : h.orbit.pan;
    const other = nav === 'orbit' ? h.orbit.pan : h.orbit.orbit;

    api.hold(nav, true);
    emitHands(handAt(300, 150, { pinching: true }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBeCloseTo(50);
    expect(spy.mock.calls[0][1]).toBeCloseTo(-50);
    if (nav === 'orbit') expect(spy.mock.calls[0][2]).toEqual(v3(300, 250, 0));
    expect(other).not.toHaveBeenCalled();
    const frozen = api.extrusion()!;
    expect(frozen.depth).toBe(preview.depth);
    expect(frozen.corners).toEqual(preview.corners);
    expect(frozen.dragging).toBe(false);
    expect(api.sketch.serialize()).toBe(serialized);

    api.hold(nav, false);
    emitHands(handAt(300, 140, { pinching: true }));
    expect(api.extrusion()!.depth).toBeCloseTo(60);
    api.press('confirm');
    api.press('undo');
    expect(api.sketch.serialize()).toBe(serialized);
  });

  it('orbit wins when Shift and Ctrl are both held, and releasing it re-baselines pan', () => {
    api.commands.addRect([v3(100, 100, 0), v3(500, 100, 0), v3(500, 400, 0), v3(100, 400, 0)]);
    api.setCursor(v2(250, 250));
    api.hold('pan', true);
    api.hold('orbit', true);
    api.setCursor(v2(300, 300));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    expect(h.orbit.orbit).toHaveBeenCalledWith(50, 50, v3(300, 250, 0));
    expect(h.orbit.pan).not.toHaveBeenCalled();
    api.hold('orbit', false);
    api.setCursor(v2(320, 310));
    expect(h.orbit.pan).toHaveBeenCalledTimes(1);
    expect(h.orbit.pan).toHaveBeenCalledWith(20, 10);
  });

  it('does not begin geometry when draw is pressed while navigating', () => {
    api.commands.addRect([v3(100, 100, 0), v3(500, 100, 0), v3(500, 400, 0), v3(100, 400, 0)]);
    const serialized = api.sketch.serialize();
    api.setCursor(v2(250, 250));
    api.hold('orbit', true);
    api.hold('draw', true);
    api.setCursor(v2(600, 500));
    api.hold('draw', false);
    api.hold('orbit', false);
    expect(api.sketch.serialize()).toBe(serialized);
    expect(api.lastRecognition()).toBeNull();
  });

  it('commits only the pre-navigation stroke when draw releases during orbit', () => {
    api.press('toggleGrid');
    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    api.setCursor(v2(150, 100));
    api.hold('orbit', true);
    api.setCursor(v2(500, 400));
    api.hold('draw', false);
    api.hold('orbit', false);
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    expect(api.extrusion()).toBeNull();
    const entity = api.sketch.last;
    expect(entity?.type).toBe('line');
    if (entity?.type === 'line') {
      expect(entity.a).toEqual(v3(100, 100, 0));
      expect(entity.b).toEqual(v3(150, 100, 0));
    }
  });

  it.each([true, false])('applies the camera once per hand frame while navigating (navAssist=%s)', (assist) => {
    if (assist) api.press('toggleNavAssist');
    api.hold('orbit', true);
    emitHands(handAt(300, 300));
    h.orbit.orbit.mockClear();
    emitHands(handAt(340, 320, {}, { mode: 'two', pan: [40, 30], zoom: 1.3, rotation: 0 }));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    expect(h.orbit.orbit).toHaveBeenCalledWith(40, 20, v3(0, 0, 0));
    expect(h.orbit.pan).not.toHaveBeenCalled();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
  });

  it('applies the camera once while pinching mid-extrusion and keeps preview + selection', () => {
    api.press('toggleNavAssist');
    startExtrusion(setHand);
    emitHands(handAt(250, 250, { pinching: true }));
    emitHands(handAt(250, 200, { pinching: true }));
    const preview = structuredClone(api.extrusion()!);
    const selectedId = api.selected()?.id;
    api.hold('orbit', true);
    h.orbit.orbit.mockClear();
    emitHands(handAt(350, 120, { pinching: true }, { mode: 'two', pan: [40, 30], zoom: 1.3, rotation: 0 }));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    expect(h.orbit.orbit.mock.calls[0][0]).toBeCloseTo(100);
    expect(h.orbit.orbit.mock.calls[0][1]).toBeCloseTo(-80);
    expect(h.orbit.orbit.mock.calls[0][2]).toEqual(v3(300, 250, 0));
    expect(h.orbit.pan).not.toHaveBeenCalled();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
    const frozen = api.extrusion()!;
    expect(frozen.depth).toBe(preview.depth);
    expect(frozen.corners).toEqual(preview.corners);
    expect(api.selected()?.id).toBe(selectedId);
  });

  it('applies the camera once with an open palm while an extrusion idles', () => {
    api.press('toggleNavAssist');
    startExtrusion(setHand);
    api.hold('orbit', true);
    emitHands(handAt(300, 250));
    h.orbit.orbit.mockClear();
    emitHands(handAt(360, 300, { open: true, openArmed: true }, { mode: 'two', pan: [10, 10], zoom: 1.2, rotation: 0 }));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    expect(h.orbit.orbit.mock.calls[0][0]).toBeCloseTo(60);
    expect(h.orbit.orbit.mock.calls[0][1]).toBeCloseTo(50);
    expect(h.orbit.orbit.mock.calls[0][2]).toEqual(v3(300, 250, 0));
    expect(h.orbit.pan).not.toHaveBeenCalled();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
  });

  it('unmodified palm navigation still drives the camera when idle', () => {
    api.press('toggleNavAssist');
    emitHands(handAt(400, 300, { open: true, openArmed: true }));
    emitHands(handAt(420, 310, { open: true, openArmed: true }, { mode: 'one', pan: [10, 20], zoom: 1, rotation: 0 }));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    expect(h.orbit.orbit).toHaveBeenCalledWith(15.625, 31.25, v3(0, 0, 0));
    h.orbit.orbit.mockClear();
    emitHands(handAt(430, 320, { open: true, openArmed: true }, { mode: 'two', pan: [40, 30], zoom: 1.3, rotation: 0 }));
    expect(h.orbit.pan).toHaveBeenCalledWith(62.5, 46.875);
    expect(h.orbit.zoom).toHaveBeenCalledWith(1.3);
  });

  it('disabled palm assist makes no camera calls', () => {
    emitHands(handAt(400, 300, { open: true, openArmed: true }));
    emitHands(handAt(420, 310, { open: true, openArmed: true }, { mode: 'one', pan: [10, 20], zoom: 1, rotation: 0 }));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    expect(h.orbit.pan).not.toHaveBeenCalled();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
  });

  it('automatic palm navigation stays blocked during an extrusion without modifiers', () => {
    api.press('toggleNavAssist');
    startExtrusion(setHand);
    emitHands(handAt(400, 300, { open: true, openArmed: true }, { mode: 'two', pan: [40, 30], zoom: 1.3, rotation: 0 }));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    expect(h.orbit.pan).not.toHaveBeenCalled();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
  });

  it('keeps the mouse fallback: right-drag orbits, middle-drag pans, wheel zooms', () => {
    api.setCursor(v2(300, 300));
    h.mouse.onHold?.('orbit', true);
    h.mouse.onMove?.(v2(350, 320));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    expect(h.orbit.orbit).toHaveBeenCalledWith(50, 20, v3(0, 0, 0));
    h.mouse.onHold?.('orbit', false);
    h.mouse.onHold?.('pan', true);
    h.mouse.onMove?.(v2(360, 330));
    expect(h.orbit.pan).toHaveBeenCalledTimes(1);
    expect(h.orbit.pan).toHaveBeenCalledWith(10, 10);
    h.mouse.onHold?.('pan', false);
    h.mouse.onWheel?.(1.15, v2(360, 330));
    expect(h.orbit.zoom.mock.calls[0][0]).toBe(1.15);
    expect(h.orbit.zoom.mock.calls[0][1]).toEqual(v2(360, 330));
  });
});

describe('navigation rebases when the cursor source changes', () => {
  beforeEach(() => {
    api.hold('orbit', true);
  });

  it('a lost hand returning far away seeds a new baseline', () => {
    emitHands(handAt(300, 300));
    emitHands(handAt(320, 300));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    h.orbit.orbit.mockClear();
    emitEmptyHands();
    emitHands(handAt(700, 600));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    emitHands(handAt(710, 600));
    expect(h.orbit.orbit).toHaveBeenCalledWith(10, 0, v3(0, 0, 0));
  });

  it('a different hand id rebases instead of jumping', () => {
    emitHands(handAt(300, 300));
    h.orbit.orbit.mockClear();
    emitHands(handAt(700, 600, { id: 2 }));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    emitHands(handAt(710, 600, { id: 2 }));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
  });

  it('the mouse taking over from a lost hand rebases', () => {
    emitHands(handAt(300, 300));
    emitEmptyHands();
    h.orbit.orbit.mockClear();
    h.mouse.onMove?.(v2(200, 200));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    h.mouse.onMove?.(v2(210, 200));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
  });

  it('a hand timeout in the frame loop rebases', () => {
    emitHands(handAt(300, 300));
    h.orbit.orbit.mockClear();
    h.nowMs += 1000;
    runFrame();
    emitHands(handAt(700, 600));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    emitHands(handAt(710, 600));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
  });

  it('tracker disconnection rebases even when the same hand id returns', () => {
    emitHands(handAt(300, 300));
    h.orbit.orbit.mockClear();
    h.tracker.onConnection?.('closed');
    h.tracker.onConnection?.('open');
    emitHands(handAt(700, 600));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    emitHands(handAt(710, 600));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
  });
});

describe('navigation safety pauses', () => {
  it('a tracking-loss hard pause survives camera navigation until a real release and regrip', () => {
    startExtrusion(setHand);
    emitHands(handAt(250, 250, { pinching: true }));
    emitHands(handAt(250, 200, { pinching: true }));
    expect(api.extrusion()!.depth).toBeCloseTo(50);
    emitEmptyHands();
    emitHands(handAt(600, 500, { pinching: true }));
    expect(api.extrusion()!.depth).toBeCloseTo(50);
    expect(api.extrusion()!.dragging).toBe(false);
    api.hold('orbit', true);
    emitHands(handAt(650, 450, { pinching: true }));
    expect(api.extrusion()!.depth).toBeCloseTo(50);
    api.hold('orbit', false);
    emitHands(handAt(660, 450, { pinching: true }));
    expect(api.extrusion()!.depth).toBeCloseTo(50);
    expect(api.extrusion()!.dragging).toBe(false);
    emitHands(handAt(660, 450));
    emitHands(handAt(660, 450, { pinching: true }));
    emitHands(handAt(660, 440, { pinching: true }));
    expect(api.extrusion()!.depth).toBeCloseTo(60);
  });

  it('the help overlay suppresses navigation and re-baselines on close', () => {
    startExtrusion();
    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    api.hold('orbit', true);
    api.setCursor(v2(300, 150));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    h.orbit.orbit.mockClear();
    api.press('help');
    api.setCursor(v2(500, 400));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    api.press('help');
    api.setCursor(v2(550, 400));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    api.setCursor(v2(560, 400));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
    expect(h.orbit.orbit).toHaveBeenCalledWith(10, 0, v3(300, 250, 0));
    api.hold('orbit', false);
    api.setCursor(v2(560, 300));
    expect(api.extrusion()!.depth).toBe(50);
    expect(api.extrusion()!.dragging).toBe(false);
    api.hold('draw', false);
    api.hold('draw', true);
    api.setCursor(v2(560, 290));
    expect(api.extrusion()!.depth).toBe(60);
  });

  it('the measure input suppresses navigation and freezes the preview', () => {
    startExtrusion();
    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    api.hold('orbit', true);
    api.press('measure');
    api.setCursor(v2(400, 300));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    expect(api.extrusion()!.depth).toBe(50);
    h.measure.isOpen = false;
    api.setCursor(v2(450, 300));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    api.setCursor(v2(460, 300));
    expect(h.orbit.orbit).toHaveBeenCalledTimes(1);
  });

  it('window blur releases all holds and keeps the preview frozen', () => {
    startExtrusion();
    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    api.hold('orbit', true);
    fire('blur');
    api.setCursor(v2(500, 400));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    expect(api.extrusion()!.depth).toBe(50);
    fire('focus');
    api.setCursor(v2(550, 400));
    api.setCursor(v2(560, 400));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    expect(api.extrusion()!.depth).toBe(50);
    expect(api.extrusion()!.dragging).toBe(false);
  });
});

describe('navigation HUD', () => {
  it('reports ORBIT and PAN as the mode while navigating mid-extrusion', () => {
    startExtrusion();
    api.hold('draw', true);
    api.hold('orbit', true);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('ORBIT');
    api.hold('orbit', false);
    api.hold('pan', true);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('PAN');
  });

  it('lists orbit and pan hints while extruding', () => {
    startExtrusion();
    runFrame();
    const keys = h.hudKeys.at(-1) ?? [];
    expect(keys).toContainEqual({ key: 'Shift', label: 'orbit' });
    expect(keys).toContainEqual({ key: 'Ctrl', label: 'pan' });
  });
});

describe('drawing commits through the timed hand path', () => {
  it('commits a rough square as a rectangle after One-Euro-smoothed hand samples', () => {
    const points = rectStroke(0, 0, 1000, 1000, { pointsPerSide: 12, jitter: 150 });
    const scale = 0.6;
    const ox = 80;
    const oy = 80;
    const previousProject = h.projector.project;
    const previousRay = h.projector.ray;
    h.projector.project = (point: Vec3): Vec2 => v2(ox + point.x * scale, oy + (point.y - point.z) * scale);
    h.projector.ray = (point: Vec2): { origin: Vec3; dir: Vec3 } => ({
      origin: { x: (point.x - ox) / scale, y: (point.y - oy) / scale, z: 1000 },
      dir: { x: 0, y: 0, z: -1 },
    });
    try {
      runFrame();
      const screenFor = (point: Vec2): Vec2 => v2(ox + point.x * scale, oy + point.y * scale);
      const first = screenFor(points[0]);
      emitHands(handAt(first.x, first.y));
      api.hold('draw', true);
      for (const point of points.slice(1)) {
        h.nowMs += 33;
        const screen = screenFor(point);
        emitHands(handAt(screen.x, screen.y));
      }
      api.hold('draw', false);
    } finally {
      h.projector.project = previousProject;
      h.projector.ray = previousRay;
    }
    expect(api.lastRecognition()?.reason).toBe('rectangle');
    expect(api.sketch.last?.type).toBe('rect');
  });

  it('commits a closed circular stroke as a rectangle and opens a box preview with Q', () => {
    const points = circleStroke(300, 250, 100);
    api.press('toggleGrid');
    api.setCursor(points[0]);
    api.hold('draw', true);
    for (const point of points.slice(1)) api.setCursor(point);
    api.hold('draw', false);

    expect(api.lastRecognition()?.reason).toMatch(/rectangle/);
    expect(api.sketch.last?.type).toBe('rect');
    expect(api.selected()?.id).toBe(api.sketch.last?.id);
    api.press('extrude');
    expect(api.extrusion()?.preview.type).toBe('extrusion');
  });
});

describe('preview rendering invalidation', () => {
  it('repaints a rectangular side pull even when depth is unchanged', () => {
    api.commands.addRect([v3(100, 100, 0), v3(500, 100, 0), v3(500, 400, 0), v3(100, 400, 0)]);
    api.setCursor(v2(300, 250));
    api.press('select');
    api.press('toggleGrid');
    api.press('extrude');
    api.hold('draw', true);
    api.setCursor(v2(300, 150));
    api.hold('draw', false);
    api.press('confirm');

    api.setCursor(v2(300, 250));
    api.press('select');
    api.press('extrude');
    api.press('cyclePlane');
    api.press('cyclePlane');
    expect(api.extrusion()?.face).toBe('right');
    const before = api.extrusion();
    h.renderer.extrusions = [];
    api.hold('draw', true);
    api.setCursor(v2(350, 250));
    api.hold('draw', false);

    const after = api.extrusion();
    expect(after?.depth).toBe(before?.depth);
    expect(after?.preview.type).toBe('extrusion');
    if (after?.preview.type === 'extrusion' && before?.preview.type === 'extrusion') {
      expect(after.preview.corners[1].x).toBeGreaterThan(before.preview.corners[1].x);
      expect(h.renderer.extrusions.at(-1)).toMatchObject({ type: 'extrusion', corners: expect.any(Array) });
    }
  });
});

describe('face switching during the first extrusion', () => {
  it.each([
    ['hand', 'confirm'],
    ['mouse', 'confirm'],
    ['hand', 'cancel'],
  ] as const)('%s input can release and pull a new side without restarting Q (%s)', (input, finish) => {
    const previousProject = h.projector.project;
    const previousRay = h.projector.ray;
    h.projector.project = (point: Vec3): Vec2 => v2(point.x - point.z, point.y);
    h.projector.ray = (point: Vec2): { origin: Vec3; dir: Vec3 } => ({
      origin: v3(point.x + 1000, point.y, 1000),
      dir: v3(-Math.SQRT1_2, 0, -Math.SQRT1_2),
    });
    const move = (point: Vec2, gripping: boolean): void => {
      if (input === 'hand') {
        emitHands(handAt(point.x, point.y, { pinching: gripping, open: !gripping, openArmed: !gripping }));
      } else {
        api.hold('draw', gripping);
        api.setCursor(point);
      }
    };
    try {
      if (input === 'hand') api.press('toggleNavAssist');
      const serialized = startExtrusion((point) => move(point, false));
      const id = api.selected()!.id;
      move(v2(250, 250), true);
      move(v2(150, 250), true);
      expect(api.extrusion()!.depth).toBeCloseTo(100);
      expect(api.extrusion()!.dragging).toBe(true);
      move(v2(150, 250), false);
      const firstPreview = structuredClone(api.extrusion()!.preview);
      expect(api.extrusion()!.dragging).toBe(false);
      move(v2(450, 250), false);
      expect(api.extrusion()!.face).toBe('right');
      expect(api.extrusion()!.preview).toEqual(firstPreview);
      expect(h.renderer.activeFaces.at(-1)).toMatchObject({ axis: 'u', sign: 1 });
      expect(api.sketch.serialize()).toBe(serialized);
      expect(api.selected()!.id).toBe(id);
      h.renderer.extrusions = [];
      move(v2(450, 250), true);
      expect(api.extrusion()!.preview).toEqual(firstPreview);
      move(v2(500, 250), true);
      move(v2(500, 250), false);
      const after = api.extrusion()!;
      expect(after.depth).toBeCloseTo(100);
      expect(after.preview.type).toBe('extrusion');
      if (after.preview.type !== 'extrusion') throw new Error('expected a box preview');
      expect(after.preview.corners[0]).toEqual(v3(100, 100, 0));
      expect(after.preview.corners[1].x).toBeCloseTo(550);
      expect(after.preview.corners[2].x).toBeCloseTo(550);
      expect(h.renderer.extrusions.at(-1)).toEqual(after.preview);
      expect(api.sketch.serialize()).toBe(serialized);
      expect(h.orbit.orbit).not.toHaveBeenCalled();
      expect(h.orbit.pan).not.toHaveBeenCalled();
      expect(h.orbit.zoom).not.toHaveBeenCalled();
      api.press(finish);
      expect(api.extrusion()).toBeNull();
      if (finish === 'cancel') {
        expect(api.sketch.serialize()).toBe(serialized);
        expect(api.commands.undo()).toBe('add rect');
      } else {
        expect(api.sketch.get(id)).toEqual(after.preview);
        const committed = api.sketch.serialize();
        api.press('undo');
        expect(api.sketch.serialize()).toBe(serialized);
        api.press('redo');
        expect(api.sketch.serialize()).toBe(committed);
      }
    } finally {
      h.projector.project = previousProject;
      h.projector.ray = previousRay;
    }
  });
});

describe('preview rendering invalidation', () => {
  it('repaints a rectangular side pull even when depth is unchanged', () => {
    api.commands.addRect([v3(100, 100, 0), v3(500, 100, 0), v3(500, 400, 0), v3(100, 400, 0)]);
    api.setCursor(v2(300, 250));
    api.press('select');
    api.press('toggleGrid');
    api.press('extrude');
    api.hold('draw', true);
    api.setCursor(v2(300, 150));
    api.hold('draw', false);
    api.press('confirm');

    api.setCursor(v2(300, 250));
    api.press('select');
    api.press('extrude');
    api.press('cyclePlane');
    api.press('cyclePlane');
    expect(api.extrusion()?.face).toBe('right');
    const before = api.extrusion();
    h.renderer.extrusions = [];
    api.hold('draw', true);
    api.setCursor(v2(350, 250));
    api.hold('draw', false);

    const after = api.extrusion();
    expect(after?.depth).toBe(before?.depth);
    expect(after?.preview.type).toBe('extrusion');
    if (after?.preview.type === 'extrusion' && before?.preview.type === 'extrusion') {
      expect(after.preview.corners[1].x).toBeGreaterThan(before.preview.corners[1].x);
      expect(h.renderer.extrusions.at(-1)).toMatchObject({ type: 'extrusion', corners: expect.any(Array) });
    }
  });
});


describe('tool hold cleanup', () => {
  it.each(['move', 'scale', 'extrude'] as const)('clears drawing sources when applying or cancelling %s', (tool) => {
    for (const finish of ['confirm', 'cancel'] as const) {
      api.commands.clear();
      api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
      api.setCursor(v2(500, 400));
      api.press(tool);
      api.hold('draw', true);
      h.mouse.onHold?.('draw', true);
      api.setCursor(v2(700, 550));
      api.press(finish);

      // Another hold must not restore the tool's previous drawing sources.
      api.hold('lockX', true);
      api.hold('lockX', false);
      api.setCursor(v2(1500, 1500));
      api.hold('draw', true);
      api.setCursor(v2(1900, 1500));
      api.hold('draw', false);
      expect(api.sketch.size).toBe(2);
      expect(api.sketch.last?.type).toBe('line');
    }
  });
});

describe('shape movement', () => {
  function startMove(grid = false, setCursor: (p: Vec2) => void = (p) => api.setCursor(p)): Entity {
    const result = api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    if (!result.ok) throw new Error(result.error);
    setCursor(v2(250, 250));
    api.press('select');
    if (!grid) api.press('toggleGrid');
    api.press('move');
    return result.entity;
  }
  const preview = (id: string): Entity | undefined => h.renderer.sketches.at(-1)?.find((entity) => entity.id === id);
  const previewOrigin = (id: string): Vec3 => {
    const entity = preview(id);
    if (entity?.type !== 'rect') throw new Error('expected a rect preview');
    return entity.corners[0];
  };
  function keyDown(code: string, overrides: Record<string, unknown> = {}) {
    const event = { code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault: vi.fn(), ...overrides };
    fire('keydown', event);
    return event;
  }

  it('M moves a hovered rectangle with a left-drag and Enter commits one undoable edit', () => {
    const added = api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    if (!added.ok) throw new Error(added.error);
    const id = added.entity.id;
    api.setCursor(v2(250, 250));
    api.press('toggleGrid');
    const serialized = api.sketch.serialize();

    runFrame();
    expect(h.hudKeys.at(-1)).toContainEqual({ key: 'M', label: 'move' });

    const accepted = keyDown('KeyM');
    expect(accepted.preventDefault).toHaveBeenCalled();
    const rejected = keyDown('KeyM', { ctrlKey: true });
    expect(rejected.preventDefault).not.toHaveBeenCalled();
    keyDown('KeyM', { repeat: true });
    expect(api.sketch.serialize()).toBe(serialized);

    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('MOVING');
    const keys = h.hudKeys.at(-1) ?? [];
    expect(keys).toContainEqual({ key: 'Enter / M', label: 'apply' });
    expect(keys).toContainEqual({ key: 'Esc', label: 'cancel' });

    h.mouse.onHold?.('draw', true);
    h.mouse.onMove?.(v2(290, 275));
    expect(previewOrigin(id)).toEqual(v3(140, 125, 0));
    expect(api.sketch.serialize()).toBe(serialized);
    expect(api.selected()?.id).toBe(id);
    expect(api.sketch.size).toBe(1);
    expect(api.lastRecognition()).toBeNull();

    h.mouse.onHold?.('draw', false);
    h.mouse.onMove?.(v2(600, 500));
    expect(previewOrigin(id)).toEqual(v3(140, 125, 0));
    expect(api.sketch.serialize()).toBe(serialized);

    keyDown('Enter');
    const committed = api.sketch.get(id);
    if (committed?.type !== 'rect') throw new Error('expected a rect');
    expect(committed.corners[0]).toEqual(v3(140, 125, 0));
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
    api.press('undo');
    expect(api.sketch.serialize()).toBe(serialized);
    api.press('redo');
    expect(api.sketch.get(id)).toEqual(committed);
  });

  it('accumulates multiple Space drags without a regrip jump and applies on a second M', () => {
    const entity = startMove();
    const serialized = api.sketch.serialize();
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    api.hold('draw', false);
    api.setCursor(v2(600, 500));
    api.hold('draw', true);
    api.setCursor(v2(610, 515));
    api.hold('draw', false);
    expect(previewOrigin(entity.id)).toEqual(v3(150, 140, 0));
    expect(api.sketch.serialize()).toBe(serialized);

    keyDown('KeyM');
    const committed = api.sketch.get(entity.id);
    if (committed?.type !== 'rect') throw new Error('expected a rect');
    expect(committed.corners[0]).toEqual(v3(150, 140, 0));
    api.press('undo');
    expect(api.sketch.serialize()).toBe(serialized);
  });

  it('Esc cancels the move without an undo entry', () => {
    const entity = startMove();
    const serialized = api.sketch.serialize();
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    api.hold('draw', false);
    expect(previewOrigin(entity.id)).toEqual(v3(140, 125, 0));
    keyDown('Escape');
    expect(api.sketch.serialize()).toBe(serialized);
    expect(preview(entity.id)).toEqual(entity);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
    expect(api.commands.undo()).toBe('add rect');
  });

  it('confirming a zero-length move adds no history and keeps the redo stack', () => {
    const entity = startMove();
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    api.hold('draw', false);
    keyDown('KeyM');
    const movedSerialized = api.sketch.serialize();
    api.press('undo');
    api.press('move');
    keyDown('Enter');
    expect(api.sketch.get(entity.id)).toEqual(entity);
    api.press('redo');
    expect(api.sketch.serialize()).toBe(movedSerialized);
  });

  it('snaps the move delta to the grid without snapping the shape, and re-baselines on G', () => {
    const added = api.commands.addRect(makeRect(v3(100.25, 100.75, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    if (!added.ok) throw new Error(added.error);
    api.setCursor(v2(250, 250));
    api.press('select');
    api.press('move');
    api.hold('draw', true);
    api.setCursor(v2(376, 224));
    expect(previewOrigin(added.entity.id)).toEqual(v3(200.25, 100.75, 0));
    api.press('toggleGrid');
    api.setCursor(v2(386, 224));
    expect(previewOrigin(added.entity.id)).toEqual(v3(210.25, 100.75, 0));
    api.hold('draw', false);
  });

  it.each([
    ['viewTop', (p: Vec2) => ({ origin: v3(p.x, p.y, 1000), dir: v3(0, 0, -1) }), v3(0, 0, -1), v3(140, 125, 0)],
    ['viewFront', (p: Vec2) => ({ origin: v3(p.x, 1000, p.y), dir: v3(0, -1, 0) }), v3(0, -1, 0), v3(140, 100, 25)],
    ['viewRight', (p: Vec2) => ({ origin: v3(1000, p.x, p.y), dir: v3(-1, 0, 0) }), v3(-1, 0, 0), v3(100, 140, 25)],
  ] as const)('moves within the work plane after %s', (view, ray, viewDirection, expected) => {
    const added = api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    if (!added.ok) throw new Error(added.error);
    api.setCursor(v2(250, 250));
    api.press('select');
    api.press('toggleGrid');
    const previousRay = h.projector.ray;
    const previousDirection = h.viewDirection;
    h.projector.ray = ray;
    h.viewDirection = viewDirection;
    try {
      api.press('move');
      api.press(view);
      api.hold('draw', true);
      api.setCursor(v2(290, 275));
      api.hold('draw', false);
      const moved = preview(added.entity.id);
      if (moved?.type !== 'rect') throw new Error('expected a rect preview');
      expect(moved.corners[0]).toEqual(expected);
      expect(moved.corners[2]).toEqual(v3(expected.x + 400, expected.y + 300, expected.z));
    } finally {
      h.projector.ray = previousRay;
      h.viewDirection = previousDirection;
    }
  });

  it.each([
    ['a parallel ray', (p: Vec2) => ({ origin: v3(p.x, p.y, 0), dir: v3(1, 0, 0) }), v3(0, 0, -1)],
    ['an edge-on view', undefined, v3(1, 0, 0)],
  ] as const)('freezes a finite preview on %s and commits nothing', (_label, ray, viewDirection) => {
    const added = api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    if (!added.ok) throw new Error(added.error);
    api.setCursor(v2(250, 250));
    api.press('select');
    api.press('toggleGrid');
    const serialized = api.sketch.serialize();
    const previousRay = h.projector.ray;
    const previousDirection = h.viewDirection;
    if (ray) h.projector.ray = ray;
    h.viewDirection = viewDirection;
    try {
      api.press('move');
      api.hold('draw', true);
      api.setCursor(v2(290, 275));
      api.hold('draw', false);
      expect(preview(added.entity.id)).toEqual(added.entity);
      keyDown('Enter');
      expect(api.sketch.serialize()).toBe(serialized);
      expect(api.commands.undo()).toBe('add rect');
    } finally {
      h.projector.ray = previousRay;
      h.viewDirection = previousDirection;
    }
  });

  it.each(['orbit', 'pan'] as const)('%s pauses the move and re-baselines the grip without a jump', (nav) => {
    const entity = startMove();
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    const frozen = previewOrigin(entity.id);
    api.hold(nav, true);
    api.setCursor(v2(600, 500));
    const spy = nav === 'orbit' ? h.orbit.orbit : h.orbit.pan;
    const other = nav === 'orbit' ? h.orbit.pan : h.orbit.orbit;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(previewOrigin(entity.id)).toEqual(frozen);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe(nav === 'orbit' ? 'ORBIT' : 'PAN');
    api.hold(nav, false);
    api.setCursor(v2(610, 515));
    api.hold('draw', false);
    expect(previewOrigin(entity.id)).toEqual(v3(150, 140, 0));
  });

  it('ignores the wheel while gripping and re-baselines after a zoom', () => {
    const entity = startMove();
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    h.mouse.onWheel?.(-100, v2(290, 275));
    expect(h.orbit.zoom).not.toHaveBeenCalled();
    api.hold('draw', false);
    h.mouse.onWheel?.(-100, v2(290, 275));
    expect(h.orbit.zoom).toHaveBeenCalledTimes(1);
    api.press('zoomIn');
    api.hold('draw', true);
    api.setCursor(v2(300, 275));
    api.hold('draw', false);
    expect(previewOrigin(entity.id)).toEqual(v3(150, 125, 0));
  });

  it('moves with pinch grabs and resumes cleanly after a release', () => {
    const entity = startMove(false, setHand);
    emitHands(handAt(250, 250, { pinching: true }));
    emitHands(handAt(290, 275, { pinching: true }));
    expect(previewOrigin(entity.id).x).toBeCloseTo(140, 0);
    expect(previewOrigin(entity.id).y).toBeCloseTo(125, 0);
    emitHands(handAt(290, 275));
    emitHands(handAt(600, 500));
    emitHands(handAt(600, 500, { pinching: true }));
    emitHands(handAt(610, 515, { pinching: true }));
    expect(previewOrigin(entity.id).x).toBeCloseTo(150, 0);
    expect(previewOrigin(entity.id).y).toBeCloseTo(140, 0);
  });

  it.each([
    ['an empty hands frame', () => emitEmptyHands()],
    ['tracker disconnection', () => h.tracker.onConnection?.('closed')],
    ['a hand timeout', () => { h.nowMs += 700; runFrame(); }],
    ['a different hand id', () => emitHands(handAt(700, 600, { id: 2, pinching: true }))],
    ['focus loss', () => { fire('blur'); fire('focus'); }],
    ['the help overlay', () => { api.press('help'); api.press('help'); }],
  ])('a pinch interrupted by %s stays frozen until a real release and regrip', (_label, interrupt) => {
    const entity = startMove(false, setHand);
    emitHands(handAt(250, 250, { pinching: true }));
    emitHands(handAt(290, 275, { pinching: true }));
    const frozen = previewOrigin(entity.id);
    interrupt();
    emitHands(handAt(700, 600, { pinching: true }));
    expect(previewOrigin(entity.id)).toEqual(frozen);
    emitHands(handAt(700, 600));
    emitHands(handAt(700, 600, { pinching: true }));
    emitHands(handAt(710, 615, { pinching: true }));
    const moved = previewOrigin(entity.id);
    expect(moved.x - frozen.x).toBeCloseTo(10, 0);
    expect(moved.y - frozen.y).toBeCloseTo(15, 0);
    expect(moved.z).toBeCloseTo(frozen.z, 6);
  });

  it('keeps a hard release requirement through a soft navigation pause', () => {
    const entity = startMove(false, setHand);
    emitHands(handAt(250, 250, { pinching: true }));
    emitHands(handAt(290, 275, { pinching: true }));
    const frozen = previewOrigin(entity.id);
    emitEmptyHands();
    api.hold('orbit', true);
    emitHands(handAt(700, 600, { pinching: true }));
    api.hold('orbit', false);
    emitHands(handAt(710, 600, { pinching: true }));
    expect(previewOrigin(entity.id)).toEqual(frozen);
    emitHands(handAt(710, 600));
    emitHands(handAt(710, 600, { pinching: true }));
    emitHands(handAt(720, 615, { pinching: true }));
    const moved = previewOrigin(entity.id);
    expect(moved.x - frozen.x).toBeCloseTo(10, 0);
    expect(moved.y - frozen.y).toBeCloseTo(15, 0);
  });

  it('keeps automatic palm navigation disabled while moving', () => {
    api.press('toggleNavAssist');
    startMove(false, setHand);
    emitHands(handAt(400, 300, { open: true, openArmed: true }, { mode: 'two', pan: [40, 30], zoom: 1.3, rotation: 0 }));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    expect(h.orbit.pan).not.toHaveBeenCalled();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
  });

  it('cancels the move when the target is edited or deleted programmatically', () => {
    const entity = startMove();
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    api.hold('draw', false);
    api.commands.setDimension(entity.id, { width: 200, height: 150 });
    const edited = preview(entity.id);
    if (edited?.type !== 'rect') throw new Error('expected a rect');
    expect(edited.corners[0]).toEqual(v3(100, 100, 0));
    expect(edited.corners[1]).toEqual(v3(300, 100, 0));
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');

    startMove();
    const target = api.selected()!.id;
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    api.hold('draw', false);
    api.commands.deleteEntity(target);
    expect(api.sketch.get(target)).toBeUndefined();
    expect(preview(target)).toBeUndefined();
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
  });

  it('keeps the preview when an unrelated entity changes and preserves that edit on cancel', () => {
    const entity = startMove();
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    api.hold('draw', false);
    const other = api.commands.addRect(makeRect(v3(600, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 100, 100));
    if (!other.ok) throw new Error(other.error);
    api.commands.setDimension(other.entity.id, { width: 50, height: 50 });
    expect(previewOrigin(entity.id)).toEqual(v3(140, 125, 0));
    api.press('cancel');
    expect(api.sketch.get(entity.id)).toEqual(entity);
    const edited = api.sketch.get(other.entity.id);
    if (edited?.type !== 'rect') throw new Error('expected a rect');
    expect(edited.corners[1]).toEqual(v3(650, 100, 0));
    expect(edited.corners[2]).toEqual(v3(650, 150, 0));
  });

  it.each(['delete', 'undo', 'extrude', 'measure'] as const)('blocks %s during a move but not after', (action) => {
    const entity = startMove();
    const serialized = api.sketch.serialize();
    api.press(action);
    expect(api.sketch.serialize()).toBe(serialized);
    expect(api.extrusion()).toBeNull();
    expect(h.measure.isOpen).toBe(false);
    api.press('cancel');
    api.press(action);
    if (action === 'delete') expect(api.sketch.get(entity.id)).toBeUndefined();
    if (action === 'undo') expect(api.sketch.size).toBe(0);
    if (action === 'extrude') expect(api.extrusion()).not.toBeNull();
    if (action === 'measure') {
      expect(h.measure.isOpen).toBe(true);
      h.measure.isOpen = false;
      h.measure.submit = null;
    }
  });

  it('does not start a move while a stroke or extrusion is active', () => {
    api.press('toggleGrid');
    api.setCursor(v2(50, 50));
    api.hold('draw', true);
    api.setCursor(v2(80, 80));
    api.press('move');
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('DRAWING');
    api.hold('draw', false);
    api.press('cancel');

    startExtrusion();
    api.press('move');
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('EXTRUDING');
    api.press('cancel');
  });

  it.each([
    ['an input', { tagName: 'INPUT' }],
    ['a textarea', { tagName: 'TEXTAREA' }],
    ['a contenteditable element', { tagName: 'DIV', isContentEditable: true }],
  ])('ignores M inside %s', (_label, target) => {
    api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    api.setCursor(v2(250, 250));
    api.press('select');
    const event = keyDown('KeyM', { target });
    expect(event.preventDefault).not.toHaveBeenCalled();
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
  });

  it('ignores M while the measurement input is open', () => {
    api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    api.setCursor(v2(250, 250));
    api.press('select');
    api.press('measure');
    const event = keyDown('KeyM');
    expect(event.preventDefault).not.toHaveBeenCalled();
    h.measure.isOpen = false;
    h.measure.submit = null;
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
  });

  it('exports the move preview through E without committing it', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    vi.stubGlobal('fetch', request);
    startMove();
    const original = api.sketch.serialize();
    api.hold('draw', true);
    api.setCursor(v2(290, 275));
    api.hold('draw', false);
    keyDown('KeyE');
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).entities[0].points).toEqual([[140, 125, 0], [540, 125, 0], [540, 425, 0], [140, 425, 0]]);
    expect(api.sketch.serialize()).toBe(original);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('MOVING');
    api.press('cancel');
    expect(api.commands.undo()).toBe('add rect');
    await vi.waitFor(() => expect(h.toasts.some((text) => text.startsWith('Sent '))).toBe(true));
  });

  it('leaves an empty sketch in READY when M is pressed', () => {
    api.setCursor(v2(250, 250));
    const event = keyDown('KeyM');
    expect(event.preventDefault).toHaveBeenCalled();
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
    expect(api.sketch.size).toBe(0);
  });
});

describe('corner scaling', () => {
  const preview = (id: string): Entity | undefined => h.renderer.sketches.at(-1)?.find((entity) => entity.id === id);
  const previewCorner = (id: string, index: number): Vec3 => {
    const entity = preview(id);
    if (entity?.type !== 'rect' && entity?.type !== 'extrusion') throw new Error('expected a rectangular preview');
    return entity.corners[index];
  };
  const expectVec3 = (point: Vec3, x: number, y: number, z: number): void => {
    expect(point.x).toBeCloseTo(x, 6);
    expect(point.y).toBeCloseTo(y, 6);
    expect(point.z).toBeCloseTo(z, 6);
  };
  function keyDown(code: string, overrides: Record<string, unknown> = {}) {
    const event = { code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault: vi.fn(), ...overrides };
    fire('keydown', event);
    return event;
  }
  function addBox(): Entity {
    const added = api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    if (!added.ok) throw new Error(added.error);
    return added.entity;
  }
  function startScale(point: Vec2 = v2(500, 400), grid = false): Entity {
    const entity = addBox();
    api.setCursor(point);
    if (!grid) api.press('toggleGrid');
    api.press('scale');
    return entity;
  }

  it('drags a locked corner to scale a rect, applies with Enter, and undoes cleanly', () => {
    const added = api.commands.addRect(makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300));
    if (!added.ok) throw new Error(added.error);
    const id = added.entity.id;
    const before = api.sketch.serialize();
    api.press('toggleGrid');
    api.setCursor(v2(500, 400));
    runFrame();
    expect(h.hudKeys.at(-1)).toContainEqual({ key: 'R', label: 'scale' });
    keyDown('KeyR');
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('SCALING');
    const keys = h.hudKeys.at(-1) ?? [];
    expect(keys).toContainEqual({ key: 'Enter / R', label: 'apply' });
    expect(keys).toContainEqual({ key: 'Esc', label: 'cancel' });

    h.mouse.onHold?.('draw', true);
    h.mouse.onMove?.(v2(700, 550));
    const scaled = preview(id);
    if (scaled?.type !== 'rect') throw new Error('expected a rect preview');
    [v3(100, 100, 0), v3(700, 100, 0), v3(700, 550, 0), v3(100, 550, 0)].forEach((expected, index) => {
      expectVec3(scaled.corners[index], expected.x, expected.y, expected.z);
    });
    expect(api.sketch.serialize()).toBe(before);
    expect(api.lastRecognition()).toBeNull();
    const ghost = h.renderer.ghosts.at(-1);
    expect(ghost?.label?.text).toContain('150%');
    expect(ghost?.label?.text).toContain('fixed corner');
    expectVec3(ghost!.label!.at, 100, 100, 0);
    expectVec3(ghost!.points![0], 100, 100, 0);
    expectVec3(ghost!.points![1], 700, 550, 0);

    h.mouse.onHold?.('draw', false);
    api.press('confirm');
    expect(h.renderer.ghosts.at(-1)).toEqual({ points: null, label: null });
    expect(api.sketch.get(id)).toEqual(scaled);
    expect(api.selected()?.id).toBe(id);
    expect(api.commands.undo()).toBe('scale rect');
    expect(api.sketch.serialize()).toBe(before);
    expect(api.commands.redo()).toBe('scale rect');
    expect(api.sketch.get(id)).toEqual(scaled);
  });

  it.each([0, 1, 2, 3])('locks rect corner %i and keeps the opposite corner fixed', (index) => {
    const entity = addBox();
    if (entity.type !== 'rect') throw new Error('expected a rect');
    const before = api.sketch.serialize();
    api.press('toggleGrid');
    const corner = entity.corners[index];
    const anchor = entity.corners[(index + 2) % 4];
    api.setCursor(v2(corner.x, corner.y));
    api.press('scale');
    api.hold('draw', true);
    api.setCursor(v2(anchor.x + 1.5 * (corner.x - anchor.x), anchor.y + 1.5 * (corner.y - anchor.y)));
    api.hold('draw', false);
    const scaled = preview(entity.id);
    if (scaled?.type !== 'rect') throw new Error('expected a rect preview');
    scaled.corners.forEach((point, j) => {
      const origin = entity.corners[j];
      expectVec3(point, anchor.x + 1.5 * (origin.x - anchor.x), anchor.y + 1.5 * (origin.y - anchor.y), 0);
    });
    expect(api.sketch.serialize()).toBe(before);
    api.press('cancel');
  });

  it('scales a line from an endpoint with the other endpoint fixed', () => {
    const added = api.commands.addLine(v3(100, 100, 0), v3(500, 400, 0));
    if (!added.ok) throw new Error(added.error);
    api.press('toggleGrid');
    api.setCursor(v2(500, 400));
    api.press('scale');
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    api.hold('draw', false);
    const scaled = preview(added.entity.id);
    expect(scaled).toMatchObject({ type: 'line', a: v3(100, 100, 0), b: v3(700, 550, 0) });
    api.press('cancel');
  });


  it.each([200, -200])('scales a box from a base corner with the opposite cap corner fixed (depth %i)', (depth) => {
    const previousProject = h.projector.project;
    const previousRay = h.projector.ray;
    h.projector.project = (point: Vec3): Vec2 => v2(point.x, point.y);
    h.projector.ray = (point: Vec2): { origin: Vec3; dir: Vec3 } => ({ origin: v3(point.x, point.y, 1000), dir: v3(0, 0, -1) });
    try {
      const entity = api.sketch.addEntity({
        type: 'extrusion',
        corners: makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300),
        depth,
      });
      if (entity.type !== 'extrusion') throw new Error('unreachable');
      const before = api.sketch.serialize();
      api.press('toggleGrid');
      api.setCursor(v2(500, 400));
      api.press('scale');
      api.hold('draw', true);
      api.setCursor(v2(700, 550));
      api.hold('draw', false);
      const scaled = preview(entity.id);
      if (scaled?.type !== 'extrusion') throw new Error('expected an extrusion preview');
      const anchor = v3(100, 100, depth);
      scaled.corners.forEach((point, j) => {
        const origin = entity.corners[j];
        expectVec3(point, anchor.x + 1.5 * (origin.x - anchor.x), anchor.y + 1.5 * (origin.y - anchor.y), anchor.z + 1.5 * (origin.z - anchor.z));
      });
      expect(scaled.depth).toBeCloseTo(depth * 1.5, 6);
      expect(api.sketch.serialize()).toBe(before);
      api.press('cancel');
      expect(api.sketch.get(entity.id)).toEqual(entity);
    } finally {
      h.projector.project = previousProject;
      h.projector.ray = previousRay;
    }
  });


  it.each([['triangle', 0], ['prism', 200], ['prism', -200]] as const)('scales a %s from a corner at depth %i', (type, depth) => {
    const previousProject = h.projector.project;
    const previousRay = h.projector.ray;
    h.projector.project = (point: Vec3): Vec2 => v2(point.x, point.y);
    h.projector.ray = (point: Vec2) => ({ origin: v3(point.x, point.y, 1000), dir: v3(0, 0, -1) });
    try {
      const corners: [Vec3, Vec3, Vec3] = [v3(100, 100, 0), v3(500, 100, 0), v3(200, 400, 0)];
      const entity = api.sketch.addEntity(type === 'triangle' ? { type, corners } : { type, corners, depth });
      const before = api.sketch.serialize();
      api.press('toggleGrid');
      api.setCursor(v2(200, 400));
      api.press('scale');
      api.hold('draw', true);
      api.setCursor(v2(50, 550));
      api.hold('draw', false);
      const scaled = preview(entity.id);
      if (scaled?.type !== 'triangle' && scaled?.type !== 'prism') throw new Error('expected a triangular preview');
      expectVec3(scaled.corners[0], -100, 100, -depth / 2);
      expectVec3(scaled.corners[1], 500, 100, -depth / 2);
      expectVec3(scaled.corners[2], 50, 550, -depth / 2);
      if (scaled.type === 'prism') expect(scaled.depth).toBeCloseTo(depth * 1.5, 6);
      expect(api.sketch.serialize()).toBe(before);
      api.press('confirm');
      expect(api.sketch.get(entity.id)).toEqual(scaled);
      expect(api.commands.undo()).toBe(`scale ${type}`);
      expect(api.sketch.serialize()).toBe(before);
    } finally {
      h.projector.project = previousProject;
      h.projector.ray = previousRay;
    }
  });

  it.each([
    ['perspective', () => new PerspectiveCamera(45, 1.25, 1, 100000)],
    ['orthographic', () => new OrthographicCamera(-1000, 1000, 800, -800, 1, 100000)],
  ] as const)('scales a box uniformly in 3D through a real %s camera regardless of the work plane', (_label, makeCamera) => {
    const camera = makeCamera();
    camera.position.set(1600, -1800, 1400);
    camera.up.set(0, 0, 1);
    camera.lookAt(200, 150, 50);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const raycaster = new Raycaster();
    const previousProject = h.projector.project;
    const previousRay = h.projector.ray;
    h.projector.project = (point: Vec3): Vec2 => {
      const ndc = new Vector3(point.x, point.y, point.z).project(camera);
      return v2((ndc.x + 1) * 500, (1 - ndc.y) * 400);
    };
    h.projector.ray = (point: Vec2): { origin: Vec3; dir: Vec3 } => {
      raycaster.setFromCamera(new Vector2(point.x / 500 - 1, 1 - point.y / 400), camera);
      return {
        origin: v3(raycaster.ray.origin.x, raycaster.ray.origin.y, raycaster.ray.origin.z),
        dir: v3(raycaster.ray.direction.x, raycaster.ray.direction.y, raycaster.ray.direction.z),
      };
    };
    try {
      const entity = api.sketch.addEntity({
        type: 'extrusion',
        corners: makeRect(v3(100, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300),
        depth: 200,
      });
      if (entity.type !== 'extrusion') throw new Error('unreachable');
      api.press('toggleGrid');
      api.press('cyclePlane');
      const start = h.projector.project(v3(500, 400, 0));
      api.setCursor(start);
      api.press('scale');
      api.hold('draw', true);
      api.setCursor(h.projector.project(v3(900, 700, -200)));
      api.hold('draw', false);
      const scaled = preview(entity.id);
      if (scaled?.type !== 'extrusion') throw new Error('expected an extrusion preview');
      const anchor = v3(100, 100, 200);
      scaled.corners.forEach((point, j) => {
        const origin = entity.corners[j];
        expectVec3(point, anchor.x + 2 * (origin.x - anchor.x), anchor.y + 2 * (origin.y - anchor.y), anchor.z + 2 * (origin.z - anchor.z));
      });
      expect(scaled.depth).toBeCloseTo(400, 4);
      api.press('cancel');
      expect(api.sketch.get(entity.id)).toEqual(entity);
    } finally {
      h.projector.project = previousProject;
      h.projector.ray = previousRay;
    }
  });

  it('requires a corner lock first, then keeps scaling the same shape when the cursor roams', () => {
    const entity = addBox();
    api.setCursor(v2(300, 250));
    api.press('toggleGrid');
    api.press('scale');
    api.hold('draw', true);
    api.setCursor(v2(350, 300));
    api.setCursor(v2(320, 260));
    expect(preview(entity.id)).toBe(entity);
    api.setCursor(v2(500, 400));
    api.setCursor(v2(700, 550));
    expectVec3(previewCorner(entity.id, 2), 700, 550, 0);
    api.setCursor(v2(50, 700));
    expectVec3(previewCorner(entity.id, 2), 356, 292, 0);
    expect(previewCorner(entity.id, 0)).toEqual(v3(100, 100, 0));
    api.hold('draw', false);
    api.press('cancel');
    expect(api.sketch.get(entity.id)).toEqual(entity);
  });

  it('rebases the pointer on regrips without jumping and adds no history until applied', () => {
    const entity = startScale();
    const before = api.sketch.serialize();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    expectVec3(previewCorner(entity.id, 2), 700, 550, 0);
    api.hold('draw', false);
    api.setCursor(v2(600, 500));
    api.hold('draw', true);
    api.setCursor(v2(680, 560));
    api.hold('draw', false);
    expectVec3(previewCorner(entity.id, 2), 780, 610, 0);
    expect(previewCorner(entity.id, 0)).toEqual(v3(100, 100, 0));
    expect(api.sketch.serialize()).toBe(before);
    api.press('cancel');
  });

  it('snaps the scale factor to the grid along the diagonal and re-baselines on G', () => {
    const entity = addBox();
    api.setCursor(v2(500, 400));
    api.press('scale');
    api.hold('draw', true);
    api.setCursor(v2(600, 475));
    expectVec3(previewCorner(entity.id, 2), 580, 460, 0);
    api.press('toggleGrid');
    api.setCursor(v2(640, 505));
    expectVec3(previewCorner(entity.id, 2), 620, 490, 0);
    api.hold('draw', false);
    api.press('cancel');
  });

  it('rejects collapsing or inverted drags and resumes from the last valid preview', () => {
    const entity = startScale();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    const good = preview(entity.id);
    api.setCursor(v2(50, 50));
    expect(preview(entity.id)).toBe(good);
    api.setCursor(v2(600, 475));
    expectVec3(previewCorner(entity.id, 2), 600, 475, 0);
    const scaled = preview(entity.id);
    api.setCursor(v2(Infinity, Infinity));
    expect(preview(entity.id)).toBe(scaled);
    api.setCursor(v2(700, 550));
    expect(preview(entity.id)).toBe(scaled);
    api.setCursor(v2(710, 560));
    const moved = previewCorner(entity.id, 2);
    expect(moved.x).toBeGreaterThan(600);
    expect(previewCorner(entity.id, 0)).toEqual(v3(100, 100, 0));
    api.hold('draw', false);
    api.press('cancel');
  });

  it('Esc cancels without an undo entry and restores the selection', () => {
    const entity = startScale();
    const before = api.sketch.serialize();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    api.hold('draw', false);
    keyDown('Escape');
    expect(api.sketch.serialize()).toBe(before);
    expect(h.renderer.ghosts.at(-1)).toEqual({ points: null, label: null });
    expect(preview(entity.id)).toEqual(entity);
    expect(api.selected()?.id).toBe(entity.id);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
    expect(api.commands.undo()).toBe('add rect');
  });

  it('applying without a grip keeps the shape and the redo stack', () => {
    const entity = startScale();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    api.hold('draw', false);
    api.press('scale');
    const scaledSerialized = api.sketch.serialize();
    api.press('undo');
    api.press('scale');
    api.press('confirm');
    expect(api.sketch.get(entity.id)).toEqual(entity);
    api.press('redo');
    expect(api.sketch.serialize()).toBe(scaledSerialized);
  });

  it.each([
    ['an empty hands frame', () => emitEmptyHands()],
    ['tracker disconnection', () => h.tracker.onConnection?.('closed')],
    ['a hand timeout', () => { h.nowMs += 700; runFrame(); }],
    ['a different hand id', () => emitHands(handAt(700, 600, { id: 2, pinching: true }))],
    ['focus loss', () => { fire('blur'); fire('focus'); }],
    ['the help overlay', () => { api.press('help'); api.press('help'); }],
  ])('a pinch scaling interrupted by %s stays frozen until a real release and regrip', (_label, interrupt) => {
    const entity = addBox();
    setHand(v2(500, 400));
    api.press('toggleGrid');
    api.press('scale');
    emitHands(handAt(500, 400, { pinching: true }));
    emitHands(handAt(700, 550, { pinching: true }));
    const frozen = previewCorner(entity.id, 2);
    expect(frozen.x).toBeCloseTo(700, 0);
    interrupt();
    emitHands(handAt(700, 600, { pinching: true }));
    expect(previewCorner(entity.id, 2)).toEqual(frozen);
    emitHands(handAt(700, 600));
    emitHands(handAt(700, 600, { pinching: true }));
    emitHands(handAt(710, 615, { pinching: true }));
    const moved = previewCorner(entity.id, 2);
    expect(moved.x - frozen.x).toBeCloseTo(13.6, 0);
    expect(moved.y - frozen.y).toBeCloseTo(10.2, 0);
    expect(previewCorner(entity.id, 0)).toEqual(v3(100, 100, 0));
    api.press('cancel');
  });

  it('switches from a pinch to a mouse drag without losing the locked corner', () => {
    const entity = addBox();
    setHand(v2(500, 400));
    api.press('toggleGrid');
    api.press('scale');
    emitHands(handAt(500, 400, { pinching: true }));
    emitHands(handAt(700, 550, { pinching: true }));
    const frozen = previewCorner(entity.id, 2);
    emitEmptyHands();
    h.mouse.onMove?.(v2(700, 600));
    expect(previewCorner(entity.id, 2)).toEqual(frozen);
    h.mouse.onHold?.('draw', true);
    h.mouse.onMove?.(v2(710, 615));
    const moved = previewCorner(entity.id, 2);
    expect(moved.x - frozen.x).toBeCloseTo(13.6, 0);
    h.mouse.onHold?.('draw', false);
    api.press('cancel');
  });

  it('keeps a hard release requirement through a soft navigation pause', () => {
    const entity = addBox();
    setHand(v2(500, 400));
    api.press('toggleGrid');
    api.press('scale');
    emitHands(handAt(500, 400, { pinching: true }));
    emitHands(handAt(700, 550, { pinching: true }));
    const frozen = previewCorner(entity.id, 2);
    emitEmptyHands();
    api.hold('orbit', true);
    emitHands(handAt(700, 600, { pinching: true }));
    api.hold('orbit', false);
    emitHands(handAt(710, 600, { pinching: true }));
    expect(previewCorner(entity.id, 2)).toEqual(frozen);
    emitHands(handAt(710, 600));
    emitHands(handAt(710, 600, { pinching: true }));
    emitHands(handAt(720, 615, { pinching: true }));
    expect(previewCorner(entity.id, 2).x).toBeGreaterThan(frozen.x);
    api.press('cancel');
  });

  it.each(['orbit', 'pan'] as const)('%s pauses scaling and re-baselines the grip without a jump', (nav) => {
    const entity = startScale();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    const frozen = previewCorner(entity.id, 2);
    api.hold(nav, true);
    api.setCursor(v2(600, 500));
    const spy = nav === 'orbit' ? h.orbit.orbit : h.orbit.pan;
    const other = nav === 'orbit' ? h.orbit.pan : h.orbit.orbit;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(previewCorner(entity.id, 2)).toEqual(frozen);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe(nav === 'orbit' ? 'ORBIT' : 'PAN');
    api.hold(nav, false);
    api.setCursor(v2(610, 515));
    api.hold('draw', false);
    const moved = previewCorner(entity.id, 2);
    expect(moved.x - frozen.x).toBeCloseTo(13.6, 6);
    expect(moved.y - frozen.y).toBeCloseTo(10.2, 6);
    expect(previewCorner(entity.id, 0)).toEqual(v3(100, 100, 0));
    api.press('cancel');
  });

  it.each(['viewIso', 'viewTop', 'viewFront', 'viewRight', 'toggleProjection', 'cyclePlane', 'zoomIn', 'zoomOut', 'fitAll'] as const)(
    'allows %s mid-grip and re-baselines without a jump',
    (action) => {
      const entity = startScale();
      api.hold('draw', true);
      api.setCursor(v2(700, 550));
      const frozen = previewCorner(entity.id, 2);
      api.press(action);
      expect(previewCorner(entity.id, 2)).toEqual(frozen);
      api.setCursor(v2(710, 565));
      const moved = previewCorner(entity.id, 2);
      expect(moved.x - frozen.x).toBeCloseTo(13.6, 6);
      expect(moved.y - frozen.y).toBeCloseTo(10.2, 6);
      api.hold('draw', false);
      api.press('cancel');
    },
  );

  it('ignores the wheel while gripping and re-baselines after a zoom', () => {
    const entity = startScale();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    h.mouse.onWheel?.(-100, v2(700, 550));
    expect(h.orbit.zoom).not.toHaveBeenCalled();
    api.hold('draw', false);
    h.mouse.onWheel?.(-100, v2(700, 550));
    expect(h.orbit.zoom).toHaveBeenCalledTimes(1);
    api.hold('draw', true);
    api.setCursor(v2(710, 565));
    api.hold('draw', false);
    expect(previewCorner(entity.id, 2).x).toBeCloseTo(713.6, 6);
    api.press('cancel');
  });

  it('re-baselines the grip on viewport resize without a jump', () => {
    const entity = startScale();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    const frozen = previewCorner(entity.id, 2);
    for (const cb of h.resizeCallbacks) cb();
    api.setCursor(v2(710, 565));
    expect(previewCorner(entity.id, 2)).toEqual(frozen);
    api.setCursor(v2(720, 580));
    api.hold('draw', false);
    expect(previewCorner(entity.id, 2).x).toBeCloseTo(713.6, 6);
    api.press('cancel');
  });

  it('keeps automatic palm navigation disabled while scaling', () => {
    api.press('toggleNavAssist');
    addBox();
    setHand(v2(500, 400));
    api.press('scale');
    emitHands(handAt(400, 300, { open: true, openArmed: true }, { mode: 'two', pan: [40, 30], zoom: 1.3, rotation: 0 }));
    expect(h.orbit.orbit).not.toHaveBeenCalled();
    expect(h.orbit.pan).not.toHaveBeenCalled();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
    api.press('cancel');
  });

  it('cancels scaling when the target is edited or deleted programmatically', () => {
    const entity = startScale();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    api.hold('draw', false);
    api.commands.setDimension(entity.id, { width: 200, height: 150 });
    const edited = preview(entity.id);
    if (edited?.type !== 'rect') throw new Error('expected a rect');
    expect(edited.corners[0]).toEqual(v3(100, 100, 0));
    expect(edited.corners[1]).toEqual(v3(300, 100, 0));
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');

    startScale();
    const target = api.selected()!.id;
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    api.hold('draw', false);
    api.commands.deleteEntity(target);
    expect(api.sketch.get(target)).toBeUndefined();
    expect(preview(target)).toBeUndefined();
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
  });

  it('keeps the preview when an unrelated entity changes and preserves that edit on cancel', () => {
    const entity = startScale();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    api.hold('draw', false);
    const other = api.commands.addRect(makeRect(v3(600, 100, 0), v3(1, 0, 0), v3(0, 1, 0), 100, 100));
    if (!other.ok) throw new Error(other.error);
    api.commands.setDimension(other.entity.id, { width: 50, height: 50 });
    expectVec3(previewCorner(entity.id, 2), 700, 550, 0);
    api.press('cancel');
    expect(api.sketch.get(entity.id)).toEqual(entity);
    const edited = api.sketch.get(other.entity.id);
    if (edited?.type !== 'rect') throw new Error('expected a rect');
    expect(edited.corners[1]).toEqual(v3(650, 100, 0));
    expect(edited.corners[2]).toEqual(v3(650, 150, 0));
  });

  it.each(['delete', 'undo', 'redo', 'clear', 'move', 'extrude', 'measure', 'select'] as const)(
    'blocks %s during scaling but not after',
    (action) => {
      const entity = startScale();
      const before = api.sketch.serialize();
      api.hold('draw', true);
      api.setCursor(v2(700, 550));
      api.hold('draw', false);
      api.press(action);
      expect(api.sketch.serialize()).toBe(before);
      expect(api.extrusion()).toBeNull();
      expect(h.measure.isOpen).toBe(false);
      runFrame();
      expect(h.hudStates.at(-1)?.mode).toBe('SCALING');
      api.press('cancel');
      api.press(action);
      if (action === 'delete') expect(api.sketch.get(entity.id)).toBeUndefined();
      if (action === 'undo' || action === 'clear') expect(api.sketch.size).toBe(0);
      if (action === 'move') {
        runFrame();
        expect(h.hudStates.at(-1)?.mode).toBe('MOVING');
        api.press('cancel');
      }
      if (action === 'extrude') {
        expect(api.extrusion()).not.toBeNull();
        api.press('cancel');
      }
      if (action === 'measure') {
        expect(h.measure.isOpen).toBe(true);
        h.measure.isOpen = false;
        h.measure.submit = null;
      }
    },
  );

  it.each([
    ['an input', { tagName: 'INPUT' }],
    ['a textarea', { tagName: 'TEXTAREA' }],
    ['a contenteditable element', { tagName: 'DIV', isContentEditable: true }],
  ])('ignores R inside %s', (_label, target) => {
    addBox();
    api.setCursor(v2(250, 250));
    api.press('select');
    const event = keyDown('KeyR', { target });
    expect(event.preventDefault).not.toHaveBeenCalled();
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
  });

  it('ignores R while the measurement input or the help overlay is open', () => {
    addBox();
    api.setCursor(v2(250, 250));
    api.press('select');
    api.press('measure');
    keyDown('KeyR');
    h.measure.isOpen = false;
    h.measure.submit = null;
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
    api.press('help');
    keyDown('KeyR');
    api.press('help');
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
  });

  it('does not start scaling while drawing, navigating, moving, or extruding', () => {
    api.press('toggleGrid');
    api.setCursor(v2(50, 50));
    api.hold('draw', true);
    api.setCursor(v2(80, 80));
    api.press('scale');
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('DRAWING');
    api.hold('draw', false);
    api.press('cancel');

    api.hold('orbit', true);
    api.press('scale');
    api.hold('orbit', false);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');

    addBox();
    api.setCursor(v2(250, 250));
    api.press('select');
    api.press('move');
    api.press('scale');
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('MOVING');
    api.press('cancel');

    api.press('extrude');
    api.press('scale');
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('EXTRUDING');
    api.press('cancel');
  });

  it('commits once on R and ignores the auto-repeated key', () => {
    startScale();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    api.hold('draw', false);
    keyDown('KeyR');
    keyDown('KeyR', { repeat: true });
    expect(api.commands.undo()).toBe('scale rect');
    expect(api.commands.undo()).toBe('add rect');
  });

  it('does not scale when the locked diagonal is degenerate on screen', () => {
    const previousProject = h.projector.project;
    const previousRay = h.projector.ray;
    h.projector.project = (point: Vec3): Vec2 => v2(point.x, point.y);
    h.projector.ray = (point: Vec2): { origin: Vec3; dir: Vec3 } => ({ origin: v3(point.x, point.y, 1000), dir: v3(0, 0, -1) });
    try {
      const added = api.commands.addLine(v3(100, 100, 0), v3(100, 100, 100));
      if (!added.ok) throw new Error(added.error);
      const id = added.entity.id;
      const before = api.sketch.serialize();
      api.press('toggleGrid');
      api.setCursor(v2(100, 100));
      api.press('scale');
      api.hold('draw', true);
      api.setCursor(v2(150, 100));
      api.hold('draw', false);
      expect(preview(id)).toEqual(added.entity);
      api.press('confirm');
      expect(api.sketch.get(id)).toEqual(added.entity);
      expect(api.sketch.serialize()).toBe(before);
      expect(api.commands.undo()).toBe('add line');
    } finally {
      h.projector.project = previousProject;
      h.projector.ray = previousRay;
    }
  });

  it.each([false, true])('can enlarge a subpixel preview again without losing its anchor (regrip %s)', (regrip) => {
    const entity = startScale();
    const before = api.sketch.serialize();
    api.hold('draw', true);
    api.setCursor(v2(100.8, 100.6));
    expectVec3(previewCorner(entity.id, 2), 100.8, 100.6, 0);
    if (regrip) {
      api.hold('draw', false);
      api.hold('draw', true);
    }
    api.setCursor(v2(300, 250));
    expectVec3(previewCorner(entity.id, 2), 300, 250, 0);
    expectVec3(previewCorner(entity.id, 0), 100, 100, 0);
    expect(api.sketch.serialize()).toBe(before);
    api.hold('draw', false);
    api.press('cancel');
    expect(preview(entity.id)).toEqual(entity);
  });

  it('exports the scaling preview through E without committing it', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    vi.stubGlobal('fetch', request);
    startScale();
    const original = api.sketch.serialize();
    api.hold('draw', true);
    api.setCursor(v2(700, 550));
    api.hold('draw', false);
    keyDown('KeyE');
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).entities[0].points).toEqual([[100, 100, 0], [700, 100, 0], [700, 550, 0], [100, 550, 0]]);
    expect(api.sketch.serialize()).toBe(original);
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('SCALING');
    api.press('cancel');
    expect(api.commands.undo()).toBe('add rect');
    await vi.waitFor(() => expect(h.toasts.some((text) => text.startsWith('Sent '))).toBe(true));
  });

  it('leaves an empty sketch in READY when R is pressed', () => {
    api.setCursor(v2(250, 250));
    const event = keyDown('KeyR');
    expect(event.preventDefault).toHaveBeenCalled();
    runFrame();
    expect(h.hudStates.at(-1)?.mode).toBe('READY');
    expect(api.sketch.size).toBe(0);
  });
});

describe('triangle and prism workflows', () => {
  const preview = (id: string): Entity | undefined => h.renderer.sketches.at(-1)?.find((entity) => entity.id === id);
  function keyDown(code: string, overrides: Record<string, unknown> = {}) {
    const event = { code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault: vi.fn(), ...overrides };
    fire('keydown', event);
    return event;
  }
  function drawTriangle(points: Vec2[] = triangleStroke([v2(100, 100), v2(500, 100), v2(200, 400)])): void {
    api.setCursor(points[0]);
    api.hold('draw', true);
    for (const point of points.slice(1)) api.setCursor(point);
    runFrame();
    api.hold('draw', false);
  }
  function addShape(kind: 'triangle' | 'prism'): Entity {
    const added = api.commands.addTriangle([v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)]);
    if (!added.ok) throw new Error(added.error);
    if (kind === 'prism') {
      const extruded = api.commands.extrude(added.entity.id, 50);
      if (!extruded.ok) throw new Error(extruded.error);
    }
    const entity = api.sketch.get(added.entity.id);
    if (!entity) throw new Error('missing entity');
    return entity;
  }

  it('commits a freehand triangle, selects it, and ghosts it as a closed triangle', () => {
    api.press('toggleGrid');
    drawTriangle();
    const entity = api.sketch.last;
    if (entity?.type !== 'triangle') throw new Error('expected a triangle');
    expect(api.lastRecognition()?.reason).toBe('triangle');
    expect(api.selected()?.id).toBe(entity.id);
    const ghostIndex = h.renderer.ghosts.map((entry) => entry.points !== null).lastIndexOf(true);
    const ghost = h.renderer.ghosts[ghostIndex];
    expect(h.renderer.ghostClosed[ghostIndex]).toBe(true);
    expect(ghost?.points).toHaveLength(3);
    expect(ghost?.label?.text).toBe('Triangle');
    const [a, b, c] = entity.corners;
    expect(ghost?.label?.at).toEqual(v3(a.x / 3 + b.x / 3 + c.x / 3, a.y / 3 + b.y / 3 + c.y / 3, a.z / 3 + b.z / 3 + c.z / 3));
    expect(h.renderer.ghosts.at(-1)).toEqual({ points: null, label: null });
  });

  it('Q pulls a triangle into a prism preview and commits with the same id', () => {
    api.press('toggleGrid');
    drawTriangle();
    const id = api.sketch.last!.id;
    const serialized = api.sketch.serialize();
    api.press('extrude');
    expect(api.extrusion()).toMatchObject({ depth: 0, dragging: false, preview: { type: 'prism', depth: 0 } });
    api.setCursor(v2(50, 50));
    api.hold('draw', true);
    api.setCursor(v2(50, 0));
    expect(api.extrusion()).toMatchObject({ depth: 50, dragging: true, preview: { type: 'prism', depth: 50 } });
    expect(api.sketch.serialize()).toBe(serialized);
    api.hold('draw', false);
    api.press('confirm');
    expect(api.extrusion()).toBeNull();
    expect(api.sketch.get(id)).toMatchObject({ type: 'prism', depth: 50 });
    api.press('undo');
    expect(api.sketch.get(id)).toMatchObject({ type: 'triangle' });
    api.press('redo');
    expect(api.sketch.get(id)).toMatchObject({ type: 'prism', depth: 50 });
  });

  it('keeps a zero-depth extrusion live instead of committing a flat prism', () => {
    api.press('toggleGrid');
    drawTriangle();
    api.press('extrude');
    api.press('confirm');
    expect(api.extrusion()).not.toBeNull();
    expect(api.sketch.last?.type).toBe('triangle');
    api.press('cancel');
    expect(api.extrusion()).toBeNull();
    expect(api.sketch.last?.type).toBe('triangle');
  });

  it('accepts an exact negative pull and cancels back to the triangle', () => {
    api.press('toggleGrid');
    drawTriangle();
    const id = api.sketch.last!.id;
    api.press('extrude');
    api.press('measure');
    h.measure.submit?.('-250');
    h.measure.isOpen = false;
    expect(api.extrusion()).toMatchObject({ depth: -250, dragging: false, preview: { type: 'prism', depth: -250 } });
    api.press('cancel');
    expect(api.extrusion()).toBeNull();
    expect(api.sketch.get(id)).toMatchObject({ type: 'triangle' });
    expect(api.commands.undo()).toBe('add triangle');
  });

  it('moves a prism with a mouse drag, preserving depth, and commits undoably', () => {
    const entity = addShape('prism');
    api.setCursor(v2(50, 50));
    api.press('select');
    api.press('toggleGrid');
    const serialized = api.sketch.serialize();
    api.press('move');
    api.hold('draw', true);
    api.setCursor(v2(90, 75));
    api.hold('draw', false);
    const moved = preview(entity.id);
    if (moved?.type !== 'prism') throw new Error('expected a prism preview');
    expect(moved.depth).toBe(50);
    expect(moved.corners[0]).toEqual(v3(40, 25, 0));
    expect(api.sketch.serialize()).toBe(serialized);
    keyDown('Enter');
    const committed = api.sketch.get(entity.id);
    if (committed?.type !== 'prism') throw new Error('expected a prism');
    expect(committed.depth).toBe(50);
    expect(committed.corners[0]).toEqual(v3(40, 25, 0));
    expect(api.selected()?.id).toBe(entity.id);
    api.press('undo');
    expect(api.sketch.serialize()).toBe(serialized);
    api.press('redo');
    expect(api.sketch.get(entity.id)).toEqual(committed);
  });

  it.each([
    { kind: 'triangle', input: 'mouse', finish: 'confirm' },
    { kind: 'triangle', input: 'mouse', finish: 'cancel' },
    { kind: 'triangle', input: 'pinch', finish: 'confirm' },
    { kind: 'triangle', input: 'pinch', finish: 'cancel' },
    { kind: 'prism', input: 'mouse', finish: 'confirm' },
    { kind: 'prism', input: 'mouse', finish: 'cancel' },
    { kind: 'prism', input: 'pinch', finish: 'confirm' },
    { kind: 'prism', input: 'pinch', finish: 'cancel' },
  ] as const)('moves a $kind via $input with $finish', ({ kind, input, finish }) => {
    const entity = addShape(kind);
    api.press('toggleGrid');
    const serialized = api.sketch.serialize();
    if (input === 'mouse') api.setCursor(v2(50, 50));
    else setHand(v2(50, 50));
    api.press('select');
    api.press('move');
    const grip = (point: Vec2, down: boolean): void => {
      if (input === 'mouse') {
        api.hold('draw', down);
        api.setCursor(point);
      } else {
        emitHands(handAt(point.x, point.y, { pinching: down }));
      }
    };
    grip(v2(50, 50), true);
    grip(v2(90, 75), true);
    grip(v2(90, 75), false);
    const moved = preview(entity.id);
    expect(moved?.type).toBe(kind);
    if (moved?.type === 'triangle' || moved?.type === 'prism') {
      expect(moved.corners[0].x).toBeCloseTo(40);
      expect(moved.corners[0].y).toBeCloseTo(25);
      expect(moved.corners[0].z).toBeCloseTo(0);
      if (moved.type === 'prism') expect(moved.depth).toBe(50);
    }
    expect(api.sketch.serialize()).toBe(serialized);
    expect(api.sketch.size).toBe(1);
    api.press(finish);
    expect(api.selected()?.id).toBe(entity.id);
    if (finish === 'cancel') {
      expect(api.sketch.serialize()).toBe(serialized);
      expect(api.sketch.get(entity.id)).toEqual(entity);
      expect(api.commands.undo()).toBe(kind === 'prism' ? 'extrude prism 50 mm' : 'add triangle');
    } else {
      expect(api.sketch.get(entity.id)).toEqual(moved);
      api.press('undo');
      expect(api.sketch.serialize()).toBe(serialized);
      api.press('redo');
      expect(api.sketch.get(entity.id)).toEqual(moved);
    }
  });

  it('shows triangle Q/M hints without a size control and a depth hint on prisms', () => {
    const entity = addShape('triangle');
    api.setCursor(v2(50, 50));
    api.press('select');
    runFrame();
    const triangleKeys = h.hudKeys.at(-1) ?? [];
    expect(triangleKeys).toContainEqual({ key: 'Q', label: 'extrude triangle' });
    expect(triangleKeys).toContainEqual({ key: 'M', label: 'move' });
    expect(triangleKeys).toContainEqual({ key: 'Delete', label: 'delete' });
    expect(triangleKeys.find((hint) => hint.key === 'L')).toBeUndefined();

    expect(api.commands.extrude(entity.id, 50).ok).toBe(true);
    runFrame();
    const prismKeys = h.hudKeys.at(-1) ?? [];
    expect(prismKeys).toContainEqual({ key: 'Q', label: 'push/pull' });
    expect(prismKeys).toContainEqual({ key: 'L', label: 'depth' });
  });

  it('commits a jittered triangle after One-Euro-smoothed hand samples', () => {
    const points = triangleStroke([v2(0, 0), v2(1000, 0), v2(350, 800)], { pointsPerSide: 12, jitter: 40 });
    const scale = 0.6;
    const ox = 80;
    const oy = 80;
    const previousProject = h.projector.project;
    const previousRay = h.projector.ray;
    h.projector.project = (point: Vec3): Vec2 => v2(ox + point.x * scale, oy + (point.y - point.z) * scale);
    h.projector.ray = (point: Vec2): { origin: Vec3; dir: Vec3 } => ({
      origin: { x: (point.x - ox) / scale, y: (point.y - oy) / scale, z: 1000 },
      dir: { x: 0, y: 0, z: -1 },
    });
    try {
      runFrame();
      const screenFor = (point: Vec2): Vec2 => v2(ox + point.x * scale, oy + point.y * scale);
      const first = screenFor(points[0]);
      emitHands(handAt(first.x, first.y));
      api.hold('draw', true);
      for (const point of points.slice(1)) {
        h.nowMs += 33;
        const screen = screenFor(point);
        emitHands(handAt(screen.x, screen.y));
      }
      api.hold('draw', false);
    } finally {
      h.projector.project = previousProject;
      h.projector.ray = previousRay;
    }
    expect(api.lastRecognition()?.reason).toBe('triangle');
    expect(api.sketch.last?.type).toBe('triangle');
  });
});

describe('FreeCAD export snapshots', () => {
  const pressE = (overrides: Record<string, unknown> = {}): void => {
    fire('keydown', { code: 'KeyE', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault: vi.fn(), ...overrides });
    fire('keyup', { code: 'KeyE' });
  };
  const success = (): Response => ({ ok: true, json: async () => ({ ok: true }) } as Response);
  const stubExport = () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success());
    vi.stubGlobal('fetch', request);
    return request;
  };
  const sent = (request: ReturnType<typeof stubExport>, index: number) => JSON.parse(String(request.mock.calls[index][1]?.body));

  it('exports changed geometry on every fresh E, including while a request is pending', async () => {
    const request = stubExport();
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    api.commands.addLine(v3(12, 34, 56), v3(78, 90, 123));
    pressE();
    pressE({ repeat: true });
    expect(request).toHaveBeenCalledTimes(1);
    api.commands.addTriangle([v3(10, 20, 30), v3(110, 20, 30), v3(10, 100, 30)]);
    pressE();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe('/api/export/freecad');
    expect(sent(request, 0).entities).toEqual([{ type: 'line', points: [[12, 34, 56], [78, 90, 123]] }]);
    expect(sent(request, 1).entities.map((entity: { type: string }) => entity.type)).toEqual(['line', 'triangle']);
    finish(success());
    await vi.waitFor(() => expect(h.toasts.filter((text) => text.startsWith('Sent '))).toHaveLength(2));
  });

  it('allows another E after a failed request', async () => {
    const request = stubExport();
    request.mockRejectedValueOnce(new Error('offline'));
    api.commands.addLine(v3(0, 0, 0), v3(10, 20, 30));
    pressE();
    await vi.waitFor(() => expect(h.toasts).toContain('FreeCAD export failed: offline'));
    pressE();
    await vi.waitFor(() => expect(h.toasts.some((text) => text.startsWith('Sent '))).toBe(true));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('exports each extrusion preview without committing it, including a zero-depth face', async () => {
    const request = stubExport();
    const original = startExtrusion();
    pressE();
    expect(sent(request, 0).entities[0].type).toBe('rect');
    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    api.hold('draw', false);
    pressE();
    expect(sent(request, 1).entities[0]).toEqual({ type: 'extrusion', points: [[100, 100, 0], [500, 100, 0], [500, 400, 0], [100, 400, 0]], vector: [0, 0, 50] });
    api.hold('draw', true);
    api.setCursor(v2(250, 150));
    api.hold('draw', false);
    pressE();
    expect(sent(request, 2).entities[0].vector).toEqual([0, 0, 100]);
    expect(api.sketch.serialize()).toBe(original);
    expect(api.extrusion()?.depth).toBe(100);
    api.press('cancel');
    expect(api.sketch.serialize()).toBe(original);
    expect(api.commands.undo()).toBe('add rect');
    await vi.waitFor(() => expect(h.toasts.filter((text) => text.startsWith('Sent '))).toHaveLength(3));
  });

  it('exports a committed triangular prism through E', async () => {
    const request = stubExport();
    const result = api.commands.addTriangle([v3(10, 20, 30), v3(110, 20, 30), v3(10, 100, 30)]);
    if (!result.ok) throw new Error(result.error);
    api.commands.extrude(result.entity.id, -50);
    pressE();
    expect(sent(request, 0).entities[0]).toEqual({ type: 'prism', points: [[10, 20, 30], [110, 20, 30], [10, 100, 30]], vector: [0, 0, -50] });
    await vi.waitFor(() => expect(h.toasts.some((text) => text.startsWith('Sent '))).toBe(true));
  });

  it('exports triangle and prism previews without changing triangle history', async () => {
    const request = stubExport();
    api.commands.addTriangle([v3(100, 100, 0), v3(500, 100, 0), v3(100, 400, 0)]);
    const original = api.sketch.serialize();
    api.setCursor(v2(250, 200));
    api.press('select');
    api.press('toggleGrid');
    api.press('extrude');
    pressE();
    expect(sent(request, 0).entities[0]).toEqual({ type: 'triangle', points: [[100, 100, 0], [500, 100, 0], [100, 400, 0]] });
    api.hold('draw', true);
    api.setCursor(v2(250, 150));
    api.hold('draw', false);
    pressE();
    expect(sent(request, 1).entities[0]).toEqual({ type: 'prism', points: [[100, 100, 0], [500, 100, 0], [100, 400, 0]], vector: [0, 0, 50] });
    expect(api.sketch.serialize()).toBe(original);
    expect(api.extrusion()?.depth).toBe(50);
    api.press('cancel');
    expect(api.commands.undo()).toBe('add triangle');
    await vi.waitFor(() => expect(h.toasts.filter((text) => text.startsWith('Sent '))).toHaveLength(2));
  });

  it('keeps empty-sketch, typing, and overlay protections', () => {
    const request = stubExport();
    pressE();
    expect(h.toasts).toContain('Nothing to export yet');
    api.commands.addLine(v3(0, 0, 0), v3(10, 20, 30));
    pressE({ target: { tagName: 'INPUT' } });
    pressE({ target: { isContentEditable: true } });
    h.measure.isOpen = true;
    pressE();
    h.measure.isOpen = false;
    h.help.visible = true;
    pressE();
    expect(request).not.toHaveBeenCalled();
  });
});
