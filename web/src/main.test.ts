import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandsMessage, NavMessage, TrackedHandMessage } from './input/tracker-client';
import type { AirCadApi } from './main';
import { type ExtrusionEntity, type RectEntity } from './model/sketch';
import { add, distance, normalize, scale, sub, v2, v3, type Vec2, type Vec3 } from './model/vec';
import type { VoiceControlOptions } from './voice/control';

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
  help: { visible: false },
  measure: { isOpen: false, submit: null as null | ((text: string) => void) },
  raf: null as null | ((time: number) => void),
  nowMs: 10_000,
  voice: null as VoiceControlOptions | null,
  voiceControl: null as null | { toggle: () => void; cancel: () => void },
  glyph: { update: vi.fn() },
  guide: vi.fn(),
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
  },
}));

vi.mock('./render/sketch-renderer', () => ({
  SketchRenderer: class {
    constructor(_viewport: unknown) {}
    setSketch(): void {}
    setSelected(): void {}
    setHover(): void {}
    setExtrusion(): void {}
    setActiveFace(): void {}
    setLastLabel(): void {}
    setGhost(): void {}
    setInk(): void {}
    setLineGuide(points: readonly Vec3[] | null, label: { text: string; at: Vec3 } | null): void {
      h.guide(points, label);
    }
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
    update(...args: unknown[]): void {
      h.glyph.update(...args);
    }
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
    constructor(_root: unknown) {}
    setThumb(): void {}
    setHands(): void {}
    setCameraState(): void {}
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

vi.mock('./input/tracker-client', () => ({
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
}));

vi.mock('./voice/control', () => ({
  VoiceControl: class {
    toggle = vi.fn();
    cancel = vi.fn();
    constructor(_root: unknown, options: VoiceControlOptions) {
      h.voice = options;
      h.voiceControl = this;
    }
  },
}));

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
  h.help.visible = false;
  h.measure.isOpen = false;
  h.measure.submit = null;
  h.raf = null;
  h.nowMs = 10_000;
  h.voice = null;
  h.voiceControl = null;
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
    h.mouse.onWheel?.(-100, v2(360, 330));
    expect(h.orbit.zoom).toHaveBeenCalledWith(1.15, v2(360, 330));
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

describe('voice distance', () => {
  const captureLine = () => {
    api.press('toggleGrid');
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
      api.press('toggleGrid');
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

    api.press('toggleGrid');
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
    api.press('toggleGrid');
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
    h.mouse.onWheel?.(-100, v2(700, 600));
    runFrame();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
    expect(h.glyph.update.mock.calls.at(-1)).toEqual(frozen);
    api.press('cancel');
    h.mouse.onWheel?.(-100, v2(700, 600));
    expect(h.orbit.zoom).toHaveBeenCalledWith(1.15, v2(700, 600));
  });

  it('blocks wheel zoom while a face pull voice draft is pending', () => {
    startExtrusion();
    api.hold('draw', true);
    api.setCursor(v2(250, 200));
    const target = h.voice!.capture();
    h.mouse.onWheel?.(-100, v2(400, 400));
    runFrame();
    expect(h.orbit.zoom).not.toHaveBeenCalled();
    api.hold('draw', false);
    expect(h.voice!.execute({ distance_mm: 100 }, target).ok).toBe(true);
    h.mouse.onWheel?.(-100, v2(400, 400));
    expect(h.orbit.zoom).toHaveBeenCalledWith(1.15, v2(400, 400));
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
      api.press('toggleGrid');
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
    api.press('toggleGrid');
    api.setCursor(v2(100, 100));
    api.hold('draw', true);
    api.setCursor(v2(150, 100));
    api.hold('draw', false);
    const line = api.sketch.last;
    expect(line?.type).toBe('line');
    if (line?.type === 'line') expect(line.b).toEqual(v3(150, 100, 0));
  });

  it('shows the refined voice direction before capture and commits exactly that frozen guide', () => {
    api.press('toggleGrid');
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
    api.press('toggleGrid');
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
    api.press('toggleGrid');
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
    api.press('toggleGrid');
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
