import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandsMessage, NavMessage, TrackedHandMessage } from './input/tracker-client';
import type { AirCadApi } from './main';
import { circleStroke, rectStroke } from './model/test-helpers';
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
  renderer: { extrusions: [] as unknown[], activeFaces: [] as unknown[] },
  help: { visible: false },
  measure: { isOpen: false, submit: null as null | ((text: string) => void) },
  commands: null as null | {
    dispatch(action: unknown): { ok: boolean; error?: string };
  },
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
    onResize(): () => void {
      return () => {};
    }
    render(): void {}
    viewDirection(): Vec3 {
      return { x: 0, y: 0, z: -1 };
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

vi.mock('./ui/input-panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/input-panel')>();
  return {
    ...actual,
    InputPanel: class {
      constructor(_root: unknown, _handlers: unknown) {}
      update(): void {}
    },
  };
});

vi.mock('./ui/workspace', () => {
  const mk = () => {
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
  class WorkspaceShell {
    readonly regions = {
      appBar: mk(),
      commandBar: mk(),
      modelBrowser: mk(),
      viewControls: mk(),
      viewport: mk(),
      viewportOverlay: mk(),
      inspector: mk(),
      input: mk(),
      cameraPreview: mk(),
      statusBar: mk(),
      notifications: mk(),
      dialogs: mk(),
    };
    readonly layout = { browserVisible: true, inspectorVisible: true, inspectorTab: 'properties' as const };
    onLayoutChange(): () => void {
      return () => {};
    }
    setLayout(): void {}
    setEntityCount(): void {}
  }
  return { WorkspaceShell };
});

vi.mock('./ui/command-bar', () => ({
  AppBar: class {
    constructor(_host: unknown, callbacks: unknown) {
      h.commands = callbacks as typeof h.commands;
    }
    update(): void {}
  },
  CommandBar: class {
    constructor(_host: unknown, callbacks: unknown) {
      h.commands = callbacks as typeof h.commands;
    }
    update(): void {}
  },
}));

// Browser/inspector need real DOM; dispatcher behavior is asserted directly.
vi.mock('./ui/model-browser', () => ({
  ModelBrowser: class {
    constructor(_host: unknown, _callbacks: unknown) {}
    update(): void {}
  },
}));

vi.mock('./ui/inspector', () => ({
  Inspector: class {
    constructor(_host: unknown, _callbacks: unknown) {}
    update(): void {}
  },
}));

vi.mock('./ui/view-controls', () => ({
  ViewControls: class {
    constructor(_host: unknown, _callbacks: unknown) {}
    update(): void {}
  },
}));

vi.mock('./render/sketch-renderer', () => ({
  SketchRenderer: class {
    constructor(_viewport: unknown) {}
    setSketch(): void {}
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
    setGhost(): void {}
    setInk(): void {}
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
    flash(): void {}
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
    show(): void {}
  },
}));

vi.mock('./ui/pip', () => ({
  CameraPip: class {
    visible = true;
    constructor(_root: unknown) {}
    setThumb(): void {}
    setHands(): void {}
    setCameraState(): void {}
    setSpatial(): void {}
    setStream(): void {}
    setSource(): void {}
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
  h.renderer.extrusions = [];
  h.renderer.activeFaces = [];
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

  it('keeps extrusion hints to pull, apply, and cancel', () => {
    startExtrusion();
    runFrame();
    const keys = h.hudKeys.at(-1) ?? [];
    expect(keys).toContainEqual({ key: 'Drag / Space', label: 'pull face' });
    expect(keys).toContainEqual({ key: 'Enter / Q', label: 'apply' });
    expect(keys).toContainEqual({ key: 'Esc', label: 'cancel' });
    expect(keys.length).toBeLessThanOrEqual(4);
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

describe('workspace extrusion dispatch', () => {
  const dispatch = (action: Record<string, unknown>) =>
    (h.commands as { dispatch(a: unknown): { ok: boolean; error?: string } }).dispatch(action);

  it('rejects face switching while dragging and pulls the preview without history', () => {
    const serialized = startExtrusion();
    // A flat rectangle profile exposes two faces; index 2 is out of range.
    expect(dispatch({ type: 'setExtrusionFace', index: 1 }).ok).toBe(true);
    expect(dispatch({ type: 'setExtrusionFace', index: 2 }).ok).toBe(false);

    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    expect(api.extrusion()!.dragging).toBe(true);
    expect(dispatch({ type: 'setExtrusionFace', index: 0 })).toMatchObject({ ok: false, error: 'Release to switch faces' });
    api.hold('draw', false);

    // A typed pull updates the preview without committing anything.
    expect(dispatch({ type: 'setExtrusionPull', text: '500' }).ok).toBe(true);
    expect(Math.abs(api.extrusion()!.depth)).toBeCloseTo(500);
    expect(dispatch({ type: 'setExtrusionPull', text: 'abc' }).ok).toBe(false);
    expect(api.sketch.serialize()).toBe(serialized);

    // With a solid preview all six faces are selectable.
    expect(dispatch({ type: 'setExtrusionFace', index: 5 }).ok).toBe(true);

    expect(dispatch({ type: 'press', action: 'confirm' }).ok).toBe(true);
    expect(api.extrusion()).toBeNull();
    expect(api.sketch.all.some((entity) => entity.type === 'extrusion')).toBe(true);
  });

  it('rejects extrusion field edits with no active session', () => {
    api.commands.addRect([v3(0, 0, 0), v3(400, 0, 0), v3(400, 300, 0), v3(0, 300, 0)]);
    expect(dispatch({ type: 'setExtrusionFace', index: 0 }).ok).toBe(false);
    expect(dispatch({ type: 'setExtrusionPull', text: '500' }).ok).toBe(false);
  });
});
