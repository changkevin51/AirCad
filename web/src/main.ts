import './style.css';
import { CursorSource } from './input/cursor';
import {
  detectPlatform,
  holdActionForCode,
  labelForAction,
  resolveHold,
  resolvePress,
  type HoldAction,
  type PressAction,
} from './input/keymap';
import { MouseSource } from './input/mouse-source';
import { CALIBRATION_MIN_SAMPLES, SCALE_PRESETS, SpatialCursorSource, type ScalePreset } from './input/spatial-cursor';
import {
  ClockSync,
  defaultTrackerUrl,
  postTrackerConfig,
  TrackerClient,
  type CameraState,
  type ConnectionState,
  type HandsMessage,
  type NavMessage,
  type SpatialMessage,
  type TrackerConfigJson,
  type TrackerSource,
} from './input/tracker-client';
import { Commands } from './model/commands';
import { PLANES, nextPlaneKind, WorkPlane, type Axis, type PlaneKind } from './model/plane';
import { PlaneInference, type PlaneMode } from './model/plane-inference';
import {
  chooseStrokePlane,
  DepthStrokeBuffer,
  DEPTH_PLANE_LOCK_MM,
  rebuildPlanarSession,
  spatialToSnapResult,
} from './model/depth-plane-lock';
import { completeLineRectangle } from './model/rect-completion';
import { adaptiveGridStep, DEFAULT_SNAP_TOLERANCE_PX, snapCursor, type SnapResult } from './model/snap';
import { joinEndpoints, snapLineToSegments } from './model/spatial-join';
import { snapInPlaneAngle } from './model/spatial-plane-fit';
import {
  gridStepForScale,
  hybridRadius,
  objectRadius,
  SpatialSnapper,
  SPATIAL_MAGNET,
  SPATIAL_SCREEN_TOLERANCE_PX,
  type SpatialSnapResult,
} from './model/spatial-snap';
import { describeEntity, entityCenter, entityMidpoints, entityPoints, entityVertices, Sketch, type Entity, type EntityInput } from './model/sketch';
import { anchorAfterCommit, resolveStroke, StrokeSession, type StrokeResolution } from './model/stroke';
import { dot, nearlyEqual, type Vec2, type Vec3 } from './model/vec';
import { entityLabel, SketchRenderer } from './render/sketch-renderer';
import { AxisTriad, createGroundGrid } from './scene/grid';
import { OrbitController, type ViewPreset } from './scene/orbit';
import { SpatialCursorVisual } from './scene/spatial-cursor-visual';
import { Viewport } from './scene/viewport';
import { WorkPlaneVisual } from './scene/workplane-visual';
import { CursorGlyph } from './ui/cursor-glyph';
import { HelpOverlay } from './ui/help';
import { Hud, type KeyHint, type Mode } from './ui/hud';
import { InputPanel } from './ui/input-panel';
import { MeasureInput } from './ui/measure-input';
import { CameraPip } from './ui/pip';
import { Toasts } from './ui/toast';

const SNAP_TOLERANCE_PX = DEFAULT_SNAP_TOLERANCE_PX;
const MIN_STROKE_PX = 6;
const WORKSPACE_CUBE_MM = 400;
const DEPTH_SCALE_STORAGE_KEY = 'aircad.depthScale';
const DEFAULT_DEPTH_SCALE = 10;
const SPATIAL_DEPTH_WEIGHT = 0.6;

function loadStoredDepthScale(): number {
  try {
    const raw = globalThis.localStorage?.getItem(DEPTH_SCALE_STORAGE_KEY);
    const value = raw == null ? Number.NaN : Number(raw);
    if (SCALE_PRESETS.includes(value as ScalePreset)) return value;
  } catch {
    /* node tests have no localStorage */
  }
  return DEFAULT_DEPTH_SCALE;
}

function persistDepthScale(scale: number): void {
  try {
    globalThis.localStorage?.setItem(DEPTH_SCALE_STORAGE_KEY, String(scale));
  } catch {
    /* ignore */
  }
}

const isSpatialObjectSnap = (snap: SpatialSnapResult): boolean =>
  snap.type === 'vertex' || snap.type === 'midpoint' || snap.type === 'edge';
/** Smallest on-screen grid cell before the grid coarsens to the next step (1 / 10 / 100 / 1000 mm). */
const GRID_MIN_PX = 8;
const PALM_ORBIT_GAIN = 1.0;
const LOCK_AXES: Partial<Record<HoldAction, Axis>> = { lockX: 'x', lockY: 'y', lockZ: 'z' };
const PLANE_FOR_VIEW: Record<Exclude<ViewPreset, 'iso'>, PlaneKind> = { top: 'XY', front: 'XZ', right: 'YZ' };
const BLOCKED_WHILE_DRAWING = new Set<PressAction>([
  'viewTop',
  'viewFront',
  'viewRight',
  'viewIso',
  'toggleProjection',
  'fitAll',
  'zoomIn',
  'zoomOut',
  'cyclePlane',
  'toggleAutoPlane',
]);
const CANCEL_STROKE_FIRST = new Set<PressAction>(['undo', 'redo', 'delete', 'clear', 'measure', 'help']);
const REASON_LABELS: Record<string, string> = {
  current: 'current plane',
  view: 'view',
  vertex: 'snapped vertex',
  midpoint: 'snapped midpoint',
  edge: 'snapped edge',
  face: 'hovered face',
  unavailable: 'unusable',
  manual: 'pinned',
  stroke: 'decided by stroke',
  pending: 'pending',
  provisional: 'provisional',
};

const isObjectSnap = (snap: SnapResult): boolean =>
  snap.type === 'vertex' || snap.type === 'midpoint' || snap.type === 'edge';

/** Slide the work plane along its normal so an object snap lies on it. */
function planeThroughSnap(plane: WorkPlane, snap: SnapResult | null): WorkPlane {
  if (!snap || !isObjectSnap(snap)) return plane;
  return plane.contains(snap.world, 1e-6) ? plane : plane.withAnchor(snap.world);
}

class App {
  private readonly platform = detectPlatform();
  private readonly viewport: Viewport;
  private readonly orbit: OrbitController;
  private readonly triad = new AxisTriad();
  private readonly sketch = new Sketch();
  private readonly commands = new Commands(this.sketch);
  private readonly sketchRenderer: SketchRenderer;
  private readonly planeVisual = new WorkPlaneVisual();
  private readonly cursor = new CursorSource();
  private readonly tracker: TrackerClient;
  private readonly mouse: MouseSource;
  private readonly hud: Hud;
  private readonly toasts: Toasts;
  private readonly help: HelpOverlay;
  private readonly pip: CameraPip;
  private readonly measure: MeasureInput;
  private readonly glyph: CursorGlyph;
  private readonly panel: InputPanel;
  private readonly viewportElement: HTMLElement;
  private readonly spatialVisual = new SpatialCursorVisual();
  private readonly spatialSnapper = new SpatialSnapper();
  private readonly clockSync: ClockSync;
  private readonly spatial: SpatialCursorSource;
  private readonly inference = new PlaneInference();

  private plane = new WorkPlane('XY');
  private planeMode: PlaneMode = 'auto';
  private planeReason = 'current';
  private readonly held = new Set<HoldAction>();
  private readonly holdSources = new Map<string, HoldAction>();
  private navMode: 'orbit' | 'pan' | null = null;
  private orbitGesture = false;
  private palmNavMode: 'one' | 'two' | null = null;
  private stroke: StrokeSession | null = null;
  private depthBuffer: DepthStrokeBuffer | null = null;
  private spatialPreview: SpatialSnapResult | null = null;
  private trackerConfig: TrackerConfigJson = {
    source: 'webcam',
    cameraIndex: 0,
    target: 'finger',
    colorPreset: 'green',
    colorTolerance: 1,
  };
  private depthaiInstalled = false;
  private applyingTracker = false;
  private lastSpatialAt = 0;
  private pixelNavLast: [number, number] | null = null;
  private fittedWorkspace = false;
  private strokeGridStep = 100;
  private resolutionCache: {
    session: StrokeSession;
    revision: number;
    sketchRev: number;
    cameraRev: number;
    gridStep: number;
    gridEnabled: boolean;
    resolution: StrokeResolution;
  } | null = null;
  private sketchRevision = 0;
  private cameraRevision = 0;
  private cursorSourceTag: 'hand' | 'mouse' | null = null;
  private lastHandId: number | null = null;
  private previousCursor: Vec2 | null = null;
  private hover: Entity | null = null;
  private lastCommitted: Entity | null = null;
  private gridEnabled = true;
  private depthGridEnabled = false;
  private gridStep = 100;
  private navAssist = false;
  private connection: ConnectionState = 'closed';
  private cameraState: CameraState | null = null;
  private reportedCameraError = false;
  private lastRecognition: { reason: string; points: Vec2[]; screenExtent: number } | null = null;
  private nowMs = 0;
  private depthScaleApplied = false;

  constructor(root: HTMLElement) {
    const viewportElement = document.createElement('div');
    viewportElement.className = 'viewport';
    viewportElement.tabIndex = 0;
    root.appendChild(viewportElement);
    this.viewportElement = viewportElement;

    this.viewport = new Viewport(viewportElement);
    this.orbit = new OrbitController(this.viewport, {
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    });
    this.orbit.onChange(() => {
      this.cameraRevision++;
      this.inference.reset();
    });
    this.viewport.scene.add(createGroundGrid());
    this.viewport.scene.add(this.planeVisual.group);
    this.viewport.scene.add(this.spatialVisual.group);
    this.sketchRenderer = new SketchRenderer(this.viewport);
    this.orbit.fit(null);

    this.clockSync = new ClockSync();
    this.spatial = new SpatialCursorSource(this.clockSync);
    this.hud = new Hud(root);
    this.glyph = new CursorGlyph(root);
    this.toasts = new Toasts(root);
    this.pip = new CameraPip(root);
    this.measure = new MeasureInput(root);
    this.help = new HelpOverlay(root, this.platform);
    this.panel = new InputPanel(root, {
      onSource: (source) => void this.applyTracker({ ...this.trackerConfig, source }),
      onTarget: (target) => void this.applyTracker({ ...this.trackerConfig, target }),
      onColorPreset: (colorPreset) => void this.applyTracker({ ...this.trackerConfig, colorPreset }),
      onColorTolerance: (colorTolerance) => void this.applyTracker({ ...this.trackerConfig, colorTolerance }),
      onScale: (scale) => this.changeScale(scale),
      onSetOrigin: () => this.beginCalibration('origin'),
      onRecenter: () => this.beginCalibration('recenter'),
      onFitWorkspace: () => this.fitWorkspace(),
      onRetry: () => void this.retryTracker(),
      onCancelInteraction: () => this.cancelInteraction(),
      onReleaseFocus: () => this.focusViewport(),
    });
    this.refreshPanel();

    this.sketch.onChange(() => {
      this.sketchRevision++;
      this.sketchRenderer.setSketch(this.sketch.all);
      if (this.lastCommitted && !this.sketch.get(this.lastCommitted.id)) this.lastCommitted = this.sketch.last ?? null;
      this.sketchRenderer.setLastLabel(this.lastCommitted && this.sketch.get(this.lastCommitted.id) ? this.sketch.get(this.lastCommitted.id)! : null);
    });

    this.mouse = new MouseSource(viewportElement, {
      onMove: (point) => {
        if (this.cursor.updateMouse(point, performance.now() / 1000)) {
          this.noteCursorSource('mouse');
          this.onCursorMoved();
        }
      },
      onHold: (action, down) => this.setHold(action, down, `mouse:${action}`),
      onWheel: (factor, point) => this.zoomAtCursor(factor, point),
      onCancel: () => this.cancelInteraction(),
    });

    this.tracker = new TrackerClient(defaultTrackerUrl(), {
      onHands: (message) => this.onHands(message),
      onThumb: (message) => this.pip.setThumb(message),
      onSpatial: (message) => this.onSpatial(message),
      onStatus: (message) => {
        this.cameraState = message.camera;
        this.pip.setCameraState(this.cameraState, this.connection === 'open');
        if (message.managed?.config) this.trackerConfig = { ...this.trackerConfig, ...message.managed.config };
        this.refreshPanel();
        if (message.camera === 'error' && !this.reportedCameraError) {
          this.reportedCameraError = true;
          const extra = this.isDepthSource() ? '' : ' Using the mouse.';
          this.toasts.show(`Camera unavailable: ${message.message}.${extra}`, 'error', 6000);
        }
        if (message.camera === 'ready') this.reportedCameraError = false;
      },
      onSessionReset: (streamId, sourceRunId) => {
        this.cancelUnfinished();
        this.spatial.resetContinuity();
        this.spatial.mapping.invalidateRun(sourceRunId);
        this.spatialSnapper.reset();
        this.pixelNavLast = null;
        this.pip.setStream(streamId);
        this.refreshPanel();
      },
      onConnection: (state) => {
        this.connection = state;
        if (state !== 'open') {
          this.cursor.dropHand();
          this.endPalmNav(false);
          this.synchronizeNavigation(false);
          this.cancelUnfinished();
          this.clockSync.reset();
        }
        this.pip.setCameraState(this.cameraState, state === 'open');
      },
    });
    this.tracker.connect();

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.onKeyUp(event));
    window.addEventListener('blur', () => this.cancelInteraction());
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (globalThis.document.hidden) this.cancelInteraction();
    });
    viewportElement.focus();

    this.toasts.show('Hold Space to draw, Shift to orbit, Ctrl to pan. H for help.', 'info', 5000);
    requestAnimationFrame((time) => this.frame(time));
  }

  // ---------------------------------------------------------------- input

  private isTypingTarget(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    return (
      !!target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    );
  }

  private focusViewport(): void {
    this.viewportElement.focus?.();
  }

  /** Wire-fresh tracked point, or a clock-synced fresh sample. */
  private spatialReady(now = this.nowMs || performance.now()): boolean {
    const message = this.spatial.last;
    if (this.spatial.world && message?.state === 'tracked' && message.fresh && message.cameraMm) return true;
    return !!this.spatial.world && this.spatial.isFresh(now);
  }

  private isDrawing(): boolean {
    return !!this.stroke;
  }

  private isDepthSource(): boolean {
    return this.trackerConfig.source === 'oak';
  }

  private cancelUnfinished(): void {
    if (this.stroke) this.cancelStroke();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.isTypingTarget(event) || this.measure.isOpen) return;
    const hold = resolveHold(event, this.platform);
    if (hold) {
      event.preventDefault();
      if (!event.repeat) this.setHold(hold, true, event.code);
      return;
    }
    const press = resolvePress(event, this.platform);
    if (!press) return;
    event.preventDefault();
    if (!event.repeat || press === 'zoomIn' || press === 'zoomOut') this.doPress(press);
  }

  private onKeyUp(event: KeyboardEvent): void {
    const hold = holdActionForCode(event.code);
    if (hold) this.setHold(hold, false, event.code);
  }

  private setHold(action: HoldAction, down: boolean, source = `api:${action}`): void {
    if (down) {
      if (this.help.visible || this.measure.isOpen) return;
      this.holdSources.set(source, action);
    } else {
      this.holdSources.delete(source);
    }
    const was = this.held.has(action);
    this.held.clear();
    for (const heldAction of this.holdSources.values()) this.held.add(heldAction);
    const is = this.held.has(action);
    if (is && !was) this.beginHold(action, source);
    else if (!is && was) this.endHold(action);
    if (was !== is && this.isDrawing() && (action === 'lockX' || action === 'lockY' || action === 'lockZ')) {
      this.sampleStroke();
    }
  }

  private beginHold(action: HoldAction, source = `api:${action}`): void {
    if (action === 'draw') {
      this.endPalmNav(false);
      this.synchronizeNavigation(false);
      if (this.isDepthSource()) {
        if (source.startsWith('mouse:')) return;
        this.beginDepthStroke();
      } else {
        this.beginStroke();
      }
      return;
    }
    this.pixelNavLast = null;
    this.synchronizeNavigation(false);
  }

  private endHold(action: HoldAction): void {
    if (action === 'draw') {
      this.endStroke();
      this.synchronizeNavigation(false);
      return;
    }
    this.pixelNavLast = null;
    this.synchronizeNavigation(action === 'orbit');
  }

  private synchronizeNavigation(allowSettle = false): void {
    const blocked =
      this.isDrawing() ||
      this.held.has('draw') ||
      this.help.visible ||
      this.measure.isOpen ||
      (!this.isDepthSource() && this.cursor.isLost);
    const desired: 'orbit' | 'pan' | null = blocked ? null : this.held.has('orbit') ? 'orbit' : this.held.has('pan') ? 'pan' : null;
    const changed = desired !== this.navMode || (desired === 'orbit' && !this.orbitGesture);
    if (!changed) return;
    if (this.navMode === 'orbit') this.endOrbitGesture(allowSettle && desired === null);
    if (desired) this.endPalmNav(false);
    this.navMode = desired;
    this.previousCursor = null;
    if (desired === 'orbit' && !this.orbitGesture) {
      this.orbit.beginOrbit(this.sketch.center());
      this.orbitGesture = true;
    }
  }

  private endOrbitGesture(settle: boolean): void {
    if (this.orbitGesture) {
      this.orbit.endOrbit(settle, this.nowMs);
      this.orbitGesture = false;
    }
  }

  private endPalmNav(settle: boolean): void {
    if (this.palmNavMode === 'one' && this.orbitGesture) {
      this.orbit.endOrbit(settle, this.nowMs);
      this.orbitGesture = false;
    }
    this.palmNavMode = null;
  }

  private get axisLock(): Axis | null {
    for (const action of ['lockX', 'lockY', 'lockZ'] as const) if (this.held.has(action)) return LOCK_AXES[action] ?? null;
    return null;
  }

  private get mode(): Mode {
    if (this.isDrawing()) return 'DRAWING';
    if (this.navMode === 'orbit') return 'ORBIT';
    if (this.navMode === 'pan') return 'PAN';
    return 'READY';
  }

  private noteCursorSource(tag: 'hand' | 'mouse'): void {
    const handChanged = tag === 'hand' && (this.cursorSourceTag !== 'hand' || this.cursor.handId !== this.lastHandId);
    const mouseTakeover = tag === 'mouse' && this.cursorSourceTag !== 'mouse';
    this.cursorSourceTag = tag;
    this.lastHandId = this.cursor.handId;
    if (handChanged || mouseTakeover) {
      this.endPalmNav(false);
      this.endOrbitGesture(false);
      this.navMode = null;
      this.previousCursor = null;
      this.synchronizeNavigation(false);
    }
  }

  private onHands(message: HandsMessage): void {
    const now = performance.now() / 1000;
    this.cursor.updateHands(message, { w: this.viewport.width, h: this.viewport.height }, now);
    const hasHand = this.cursor.tracking === 'hand' && !!this.cursor.hand;
    if (hasHand) {
      this.noteCursorSource('hand');
      this.onCursorMoved();
    } else if (this.cursor.isLost) {
      this.synchronizeNavigation(false);
    }
    this.pip.setHands(message, this.cursor.handId);
    const navAllowed =
      this.navAssist &&
      hasHand &&
      !this.held.has('draw') &&
      !this.held.has('orbit') &&
      !this.held.has('pan') &&
      !this.isDrawing() &&
      !this.help.visible &&
      !this.measure.isOpen;
    if (navAllowed && message.nav) this.applyPalmNav(message.nav, message.frame);
    else if (this.palmNavMode) this.endPalmNav(navAllowed && !message.nav && this.palmNavMode === 'one');
  }

  private applyPalmNav(nav: NavMessage, frame: { w: number; h: number }): void {
    if (this.navMode || this.help.visible || this.measure.isOpen) return;
    const scale = this.viewport.width / Math.max(1, frame.w);
    const dx = nav.pan[0] * scale;
    const dy = nav.pan[1] * scale;
    if (nav.mode === 'one') {
      if (this.palmNavMode !== 'one') {
        this.endPalmNav(false);
        this.orbit.beginOrbit(this.sketch.center());
        this.orbitGesture = true;
        this.palmNavMode = 'one';
      }
      this.orbit.orbit(dx * PALM_ORBIT_GAIN, dy * PALM_ORBIT_GAIN, this.sketch.center());
    } else {
      if (this.palmNavMode === 'one') this.endPalmNav(false);
      this.palmNavMode = 'two';
      this.orbit.pan(dx, dy);
      if (nav.zoom !== 1) this.orbit.zoom(nav.zoom);
    }
  }

  // ---------------------------------------------------------------- actions

  private doPress(action: PressAction): void {
    if ((this.help.visible || this.measure.isOpen) && action !== 'help' && action !== 'cancel') return;
    if (this.isDrawing() && BLOCKED_WHILE_DRAWING.has(action)) return;
    if (this.isDrawing() && CANCEL_STROKE_FIRST.has(action)) this.cancelUnfinished();
    switch (action) {
      case 'viewTop':
      case 'viewFront':
      case 'viewRight': {
        const preset = action === 'viewTop' ? 'top' : action === 'viewFront' ? 'front' : 'right';
        this.orbit.setView(preset, true, this.nowMs);
        this.setPlaneKind(PLANE_FOR_VIEW[preset], false);
        this.pinManual();
        this.toasts.show(`${preset[0].toUpperCase()}${preset.slice(1)} view · plane ${this.plane.label}`);
        break;
      }
      case 'viewIso':
        this.orbit.setView('iso', true, this.nowMs);
        this.toasts.show('Isometric view');
        break;
      case 'toggleProjection':
        this.toasts.show(this.orbit.toggleProjection() ? 'Orthographic' : 'Perspective');
        break;
      case 'fitAll':
        if (this.isDepthSource()) this.fitWorkspace();
        else this.orbit.fit(this.sketch.boundingBox());
        break;
      case 'zoomIn':
        this.zoomAtCursor(1.25, this.cursor.position ?? undefined);
        break;
      case 'zoomOut':
        this.zoomAtCursor(1 / 1.25, this.cursor.position ?? undefined);
        break;
      case 'cyclePlane':
        this.setPlaneKind(nextPlaneKind(this.plane.kind), true);
        this.pinManual();
        break;
      case 'toggleAutoPlane': {
        this.planeMode = this.planeMode === 'auto' ? 'manual' : 'auto';
        if (this.planeMode === 'manual') {
          this.planeReason = 'manual';
          this.toasts.show(`Plane ${this.plane.label} pinned · A returns to auto`);
        } else {
          this.inference.reset();
          this.toasts.show('Automatic work plane');
        }
        break;
      }
      case 'toggleGrid':
        if (this.isDepthSource()) {
          this.depthGridEnabled = !this.depthGridEnabled;
          this.toasts.show(`Depth grid snap ${this.depthGridEnabled ? 'on' : 'off'}`);
        } else {
          this.gridEnabled = !this.gridEnabled;
          this.sampleStroke();
          this.toasts.show(`Grid snap ${this.gridEnabled ? 'on' : 'off'}`);
        }
        break;
      case 'toggleNavAssist':
        if (this.isDepthSource()) {
          this.toasts.show('Palm navigation is not available with the depth camera');
          break;
        }
        this.navAssist = !this.navAssist;
        if (!this.navAssist) this.endPalmNav(false);
        this.toasts.show(`Palm navigation ${this.navAssist ? 'on: one open palm orbits, two palms pan/zoom' : 'off'}`);
        break;
      case 'setOrigin':
        this.beginCalibration('origin');
        break;
      case 'recenter':
        this.beginCalibration('recenter');
        break;
      case 'undo': {
        const label = this.commands.undo();
        this.toasts.show(label ? `Undo ${label}` : 'Nothing to undo', label ? 'info' : 'error');
        break;
      }
      case 'redo': {
        const label = this.commands.redo();
        this.toasts.show(label ? `Redo ${label}` : 'Nothing to redo', label ? 'info' : 'error');
        break;
      }
      case 'delete': {
        const target = this.hover ?? this.sketch.last;
        const result = target ? this.commands.deleteEntity(target.id) : this.commands.deleteLast();
        this.toasts.show(result.ok ? result.message : result.error, result.ok ? 'info' : 'error');
        if (result.ok) this.hover = null;
        break;
      }
      case 'clear': {
        const count = this.commands.clear();
        this.toasts.show(count ? `Cleared ${count} entities` : 'Sketch is already empty');
        this.plane = new WorkPlane(this.plane.kind);
        this.inference.reset();
        break;
      }
      case 'cancel':
        if (this.isDrawing()) this.cancelUnfinished();
        else if (this.help.visible) this.help.hide();
        break;
      case 'measure':
        this.openMeasure();
        break;
      case 'export':
        void this.exportToFreeCad();
        break;
      case 'togglePip':
        this.toasts.show(this.pip.toggle() ? 'Camera preview on' : 'Camera preview off');
        break;
      case 'help':
        this.cancelInteraction();
        this.help.toggle();
        this.synchronizeNavigation(false);
        break;
    }
  }

  private pinManual(): void {
    this.planeMode = 'manual';
    this.planeReason = 'manual';
    this.inference.reset();
  }

  private setPlaneKind(kind: PlaneKind, announce: boolean): void {
    if (this.isDrawing()) return;
    const snap = this.cursor.position ? this.computeSnap(this.cursor.position) : null;
    this.plane = snap && isObjectSnap(snap) ? new WorkPlane(kind, snap.world) : this.plane.withKind(kind);
    if (announce) this.toasts.show(`Work plane ${this.plane.label}`);
  }

  private zoomAtCursor(factor: number, point?: Vec2): void {
    if (factor === 1 || !Number.isFinite(factor)) return;
    if (this.isDrawing() || this.help.visible || this.measure.isOpen) return;
    if (!point) {
      this.orbit.zoom(factor);
      this.inference.reset();
      return;
    }
    const snap = this.computeSnap(point);
    if (snap.type === 'vertex' || snap.type === 'midpoint' || snap.type === 'edge') {
      this.orbit.zoom(factor, snap.screen, snap.world);
    } else if (snap.raw) {
      this.orbit.zoom(factor, point, snap.raw);
    } else {
      this.orbit.zoom(factor, point);
    }
    this.inference.reset();
  }

  private openMeasure(): void {
    const target = this.hover ?? this.lastCommitted ?? this.sketch.last ?? null;
    if (!target) {
      this.toasts.show('Draw something first, then press L to set its size', 'error');
      return;
    }
    const prompt = target.type === 'line' ? `Length of ${describeEntity(target)} (mm):` : `Size of ${describeEntity(target)} (W x H mm):`;
    this.cancelInteraction();
    this.measure.open(prompt, (text) => {
      const result = this.commands.setDimension(target.id, text);
      this.toasts.show(result.ok ? result.message : result.error, result.ok ? 'success' : 'error');
      if (result.ok) {
        this.lastCommitted = result.entity;
        this.plane = this.plane.withAnchor(anchorAfterCommit(result.entity));
      }
    });
  }

  private async exportToFreeCad(): Promise<void> {
    if (!this.sketch.size) {
      this.toasts.show('Nothing to export yet', 'error');
      return;
    }
    const payload = this.commands.exportPayload();
    this.toasts.show(`Exporting ${payload.entities.length} entities to FreeCAD...`);
    try {
      const response = await fetch('/api/export/freecad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; count?: number };
      if (response.ok && body.ok) this.toasts.show(`Sent ${body.count ?? payload.entities.length} entities to FreeCAD`, 'success');
      else this.toasts.show(`FreeCAD export failed: ${body.error ?? response.statusText}`, 'error', 6000);
    } catch (error) {
      this.toasts.show(`FreeCAD export failed: ${(error as Error).message}`, 'error', 6000);
    }
  }

  private onSpatial(message: SpatialMessage): void {
    this.lastSpatialAt = this.nowMs || performance.now();
    const trackerClock = this.tracker.clock;
    if (trackerClock?.synced) {
      this.clockSync.offsetLower = trackerClock.offsetLower;
      this.clockSync.rttMs = trackerClock.rttMs;
    }
    this.spatial.apply(message, this.lastSpatialAt);
    this.pip.setSpatial(message);
    if (this.spatial.calibration.phase === 'done') this.finishCalibration();
    else if (this.spatial.calibration.phase === 'timeout') {
      if (this.spatial.cameraMm) {
        this.spatial.calibration.samples = [this.spatial.cameraMm];
        this.finishCalibration();
        return;
      }
      this.spatial.calibration.cancel();
      this.toasts.show('Origin capture timed out. Keep the tracked tip still and try again.', 'error');
    }
    if (this.mode === 'ORBIT' || this.mode === 'PAN') this.applyNavigationDelta(this.cursor.position ?? { x: 0, y: 0 });
    if (this.stroke) this.samplePlanarDepthStroke();
    else if (this.spatial.world) this.updateSpatialHover(this.spatial.world);
    this.refreshPanel();
  }

  private beginDepthStroke(): void {
    this.beginPlanarDepthStroke();
  }

  private lastEndpoint(): Vec3 | null {
    const entity = this.lastCommitted;
    if (!entity) return null;
    return entity.type === 'line' ? entity.b : entity.corners[0];
  }

  private spatialWorldPerPixel(world: Vec3): number {
    return this.viewport.worldPerPixel(world);
  }

  private spatialRadius(world: Vec3, magnet = 1): number {
    return hybridRadius(this.spatial.mapping.scale, this.spatialWorldPerPixel(world), SPATIAL_SCREEN_TOLERANCE_PX, magnet);
  }

  private computeSpatialSnap(world: Vec3, options: { magnet?: number } = {}): SpatialSnapResult {
    const plane = this.stroke?.plane ?? this.plane;
    const magnet = options.magnet ?? 1;
    const radius = this.spatialRadius(world, magnet);
    const constrainToPlane = this.planeMode === 'manual' || this.depthBuffer?.state === 'locked';
    return this.spatialSnapper.snap({
      raw: world,
      targets: { vertices: this.sketch.vertices(), midpoints: this.sketch.midpoints(), segments: this.sketch.segments() },
      scale: this.spatial.mapping.scale,
      gridEnabled: this.depthGridEnabled,
      start: this.stroke?.start.world ?? null,
      axisLock: this.stroke ? this.axisLock : null,
      planeWorld: (point) => plane.project(point),
      project: (point) => this.viewport.projector().project(point),
      worldPerPixel: this.spatialWorldPerPixel(world),
      magnet,
      prefer: this.lastEndpoint(),
      viewDir: this.viewport.viewDirection(),
      depthWeight: SPATIAL_DEPTH_WEIGHT,
      maxOffPlane: constrainToPlane ? radius : undefined,
    });
  }

  private depthRawSnap(world: Vec3, object: SpatialSnapResult): SpatialSnapResult {
    return {
      ...object,
      world: isSpatialObjectSnap(object) ? object.world : world,
      raw: world,
    };
  }

  private applyChosenDepthPlane(world: Vec3 | null, announce: boolean): StrokeSession | null {
    const buffer = this.depthBuffer;
    const stroke = this.stroke;
    if (!buffer || !stroke) return stroke;
    const points = buffer.polyline(world ?? undefined);
    const choice = chooseStrokePlane(points, buffer.start.world, {
      preferKind: buffer.prestrokeKind,
      preferPlane: buffer.prestroke,
      viewDir: this.viewport.viewDirection(),
      axisLock: this.axisLock,
    });
    buffer.state = choice.ambiguous ? 'provisional' : 'locked';
    const last = world ? this.depthRawSnap(world, this.computeSpatialSnap(world)) : buffer.start;
    if (choice.plane.equals(stroke.plane) && choice.kind === stroke.plane.kind) return stroke;
    const next = rebuildPlanarSession(choice.plane, buffer.start, points, last, spatialToSnapResult);
    this.stroke = next;
    this.resolutionCache = null;
    if (announce && !buffer.announced) {
      this.toasts.show(`Plane ${choice.plane.label} from stroke direction`);
      buffer.announced = true;
    }
    return next;
  }

  private updateSpatialHover(world: Vec3): void {
    const snap = this.computeSpatialSnap(world, { magnet: SPATIAL_MAGNET });
    this.spatialPreview = snap;
    const hovered = snap.entityId ? this.sketch.get(snap.entityId) ?? null : null;
    if (hovered !== this.hover) {
      this.hover = hovered;
      this.sketchRenderer.setHover(hovered);
    }
  }

  private resolveSpatial(session: StrokeSession): StrokeResolution {
    const scale = this.spatial.mapping.scale;
    const world = session.last.world;
    const wpp = this.spatialWorldPerPixel(world);
    const radius = this.spatialRadius(world, SPATIAL_MAGNET);
    const tolerancePx = wpp > 0 ? Math.max(SNAP_TOLERANCE_PX, radius / wpp) : SNAP_TOLERANCE_PX;
    const resolution = resolveStroke(session, {
      projector: this.viewport.projector(),
      vertices: this.sketch.vertices(),
      tolerancePx,
      gridStep: this.depthGridEnabled ? gridStepForScale(scale) : 0,
      entities: this.sketch.all,
    });
    if (resolution.status !== 'ready') return resolution;
    if (resolution.input.type === 'line') {
      const polished = this.polishDepthLine(session, resolution.input);
      return {
        status: 'ready',
        input: polished.input,
        removeIds: polished.removeIds.length ? polished.removeIds : resolution.removeIds,
        reason: polished.reason,
      };
    }
    const joinRadius = objectRadius(this.spatial.mapping.scale) * SPATIAL_MAGNET;
    return { ...resolution, input: joinEndpoints(resolution.input, this.spatialJoinTargets(), joinRadius) };
  }

  private spatialJoinTargets() {
    return {
      vertices: this.sketch.vertices(),
      midpoints: this.sketch.midpoints(),
      segments: this.sketch.segments(),
    };
  }

  private polishDepthLine(
    session: StrokeSession,
    line: Extract<EntityInput, { type: 'line' }>,
  ): {
    input: EntityInput;
    reason: string;
    angleDeg: number | null;
    ambiguous: boolean;
    removeIds: string[];
  } {
    const bothObject = isObjectSnap(session.start) && isObjectSnap(session.last);
    const axisLocked = session.start.type === 'lock' || session.last.type === 'lock';
    const joinRadius = objectRadius(this.spatial.mapping.scale) * SPATIAL_MAGNET;
    const targets = this.spatialJoinTargets();
    const planeKind = session.plane.kind;
    let a = line.a;
    let b = line.b;
    let angleDeg: number | null = null;
    let ambiguous = false;
    let reason = axisLocked ? 'axis-locked line' : 'line';

    if (!bothObject && !axisLocked) {
      const snapped = snapLineToSegments(a, b, targets.segments, {
        radius: joinRadius,
        plane: planeKind,
        startOnSegmentId: isObjectSnap(session.start) ? session.start.entityId ?? null : null,
        lockStart: isObjectSnap(session.start),
      });
      if (snapped.mode) {
        a = snapped.a;
        b = snapped.b;
        reason =
          snapped.mode === 'collinear' ? 'collinear line' : snapped.mode === 'perpendicular' ? 'perpendicular line' : 'parallel line';
      } else {
        const inPlane = snapInPlaneAngle(a, b, planeKind);
        a = inPlane.a;
        b = inPlane.b;
        angleDeg = inPlane.angleDeg;
        ambiguous = inPlane.ambiguous;
        reason = inPlane.axis ? 'axis-aligned line' : 'plane-locked line';
      }
    }

    let input = joinEndpoints({ type: 'line', a, b }, targets, joinRadius);
    if (input.type === 'line') {
      const completion = completeLineRectangle(input, { plane: session.plane, entities: this.sketch.all });
      if (completion) {
        return {
          input: { type: 'rect', corners: completion.corners },
          reason: 'assembled rectangle',
          angleDeg: null,
          ambiguous: false,
          removeIds: completion.removeIds,
        };
      }
    }
    return {
      input,
      reason,
      angleDeg: input.type === 'line' ? angleDeg : null,
      ambiguous: input.type === 'line' && ambiguous,
      removeIds: [],
    };
  }

  private openAnglePrompt(entity: Entity, kind: PlaneKind, angleDeg: number): void {
    this.measure.open(
      `Angle in ${kind} from ${PLANES[kind].uAxis.toUpperCase()} (°):`,
      (text) => {
        const result = this.commands.setLineAngle(entity.id, text, kind);
        this.toasts.show(result.ok ? result.message : result.error, result.ok ? 'success' : 'error');
        if (result.ok) {
          this.lastCommitted = result.entity;
          this.sketchRenderer.setLastLabel(result.entity);
          this.plane = this.plane.withAnchor(anchorAfterCommit(result.entity));
        }
      },
      undefined,
      String(Math.round(angleDeg)),
    );
  }

  private applyDepthScalePreset(): void {
    if (this.trackerConfig.source !== 'oak' || this.depthScaleApplied) return;
    this.spatial.mapping.setScale(loadStoredDepthScale(), this.spatial.cameraMm);
    this.depthScaleApplied = true;
  }

  private beginPlanarDepthStroke(): void {
    if (this.stroke || !this.spatial.mapping.calibrated || !this.spatial.world || !this.spatialReady()) {
      this.toasts.show('Need a calibrated, tracked point to draw on the plane', 'error');
      return;
    }
    this.orbit.cancelTransition(true);
    this.spatialSnapper.reset();
    const world = this.spatial.world;
    let plane = this.plane;
    const object = this.computeSpatialSnap(world, { magnet: SPATIAL_MAGNET });
    if (object.type === 'vertex' || object.type === 'midpoint' || object.type === 'edge') {
      plane = plane.contains(object.world, 1e-6) ? plane : plane.withAnchor(object.world);
    }
    this.plane = plane;
    const snap = this.planarDepthSnap(world, plane, { magnet: SPATIAL_MAGNET });
    this.spatialPreview = object;
    this.strokeGridStep = this.spatial.mapping.scale * 5;
    this.stroke = new StrokeSession(plane, snap, false);
    this.depthBuffer = this.planeMode === 'auto' ? new DepthStrokeBuffer(this.depthRawSnap(world, object), plane) : null;
    this.resolutionCache = null;
    this.hover = null;
    this.sketchRenderer.setHover(null);
    if (this.planeMode === 'manual' && plane.isEdgeOn(this.viewport.viewDirection())) {
      this.toasts.show(`Work plane ${plane.label} is edge-on in this view`, 'info');
    }
  }

  /** Project the measured world point onto the locked plane; never a screen-region ray. */
  private planarDepthSnap(world: Vec3, plane: WorkPlane, options: { magnet?: number } = {}): SnapResult {
    const object = this.computeSpatialSnap(world, options);
    const projected = plane.project(world);
    const useObject = object.type === 'vertex' || object.type === 'midpoint' || object.type === 'edge' || object.type === 'lock';
    const point = useObject ? object.world : projected;
    const screen = this.viewport.projector().project(point) ?? { x: 0, y: 0 };
    return {
      type: object.type === 'lock' ? 'lock' : object.type,
      world: point,
      plane: plane.toPlane(point),
      screen,
      onPlane: plane.contains(point, 1e-6),
      raw: projected,
      entityId: object.entityId,
      axis: object.axis,
    };
  }

  private samplePlanarDepthStroke(): void {
    if (!this.stroke || !this.isDepthSource()) return;
    if (!this.spatial.world || !this.spatialReady()) return;
    const world = this.spatial.world;
    const buffer = this.depthBuffer;
    if (buffer && buffer.state !== 'locked') {
      const scale = this.spatial.mapping.scale;
      buffer.append(world, scale);
      if (buffer.worldExtent(world) >= DEPTH_PLANE_LOCK_MM * scale) this.applyChosenDepthPlane(world, true);
    }
    const stroke = this.stroke;
    if (!stroke) return;
    const snap = this.planarDepthSnap(world, stroke.plane);
    this.spatialPreview = this.computeSpatialSnap(world);
    stroke.add(snap, snap.raw, snap.screen, 2, Math.max(1, this.spatial.mapping.scale));
  }

  private beginCalibration(kind: 'origin' | 'recenter'): void {
    if (!this.isDepthSource()) {
      this.toasts.show('Select Depth camera before setting the origin', 'error');
      return;
    }
    this.cancelUnfinished();
    void this.tracker.syncClock?.();
    this.spatial.calibration.start(this.nowMs || performance.now());
    this.focusViewport();
    this.toasts.show(kind === 'origin' ? 'Hold the tracked tip still to set the origin…' : 'Hold still to recenter…');
    (this as { calibrationKind?: 'origin' | 'recenter' }).calibrationKind = kind;
    this.refreshPanel();
  }

  private finishCalibration(): void {
    const median = this.spatial.calibration.median();
    this.spatial.calibration.cancel();
    if (!median) return;
    const kind = (this as { calibrationKind?: 'origin' | 'recenter' }).calibrationKind ?? 'origin';
    if (kind === 'origin') {
      this.spatial.mapping.setOrigin(median);
      this.toasts.show('Origin set', 'success');
      if (!this.sketch.size && !this.fittedWorkspace) {
        this.orbit.setView('iso', false, this.nowMs);
        this.fitWorkspace();
        this.fittedWorkspace = true;
      }
    } else {
      const world = this.lastCommitted ? anchorAfterCommit(this.lastCommitted) : { x: 0, y: 0, z: 0 };
      this.spatial.mapping.recenter(median, world);
      this.toasts.show('Recentered on the last endpoint', 'success');
    }
    this.cancelUnfinished();
    this.refreshPanel();
  }

  private changeScale(scale: number): void {
    this.cancelUnfinished();
    this.spatial.mapping.setScale(scale, this.spatial.cameraMm);
    persistDepthScale(scale);
    this.depthScaleApplied = true;
    this.refreshPanel();
  }

  private setDrawingSpace(_space?: string): void {
    this.refreshPanel();
  }

  private fitWorkspace(): void {
    const scale = this.spatial.mapping.scale;
    const half = (WORKSPACE_CUBE_MM * scale) / 2;
    const box = this.sketch.size
      ? this.sketch.boundingBox()
      : { min: { x: -half, y: -half, z: -half }, max: { x: half, y: half, z: half } };
    this.orbit.fit(box);
  }

  private async applyTracker(config: TrackerConfigJson): Promise<void> {
    const streamId = this.tracker.lastSnapshot?.streamId ?? this.spatial.streamId;
    if (!streamId) {
      this.toasts.show('Tracker is not ready yet', 'error');
      return;
    }
    this.applyingTracker = true;
    this.refreshPanel();
    this.cancelUnfinished();
    const result = await postTrackerConfig({ expectedStreamId: streamId, config });
    this.applyingTracker = false;
    if (!result.ok) {
      this.toasts.show(result.error, 'error');
      this.refreshPanel();
      return;
    }
    this.tracker.lastSnapshot = result.snapshot;
    this.trackerConfig = result.snapshot.config;
    this.depthaiInstalled = result.snapshot.capabilities.depthaiInstalled;
    this.clockSync.observe(performance.now(), performance.now(), result.snapshot.serverTimeMs);
    this.applyDepthScalePreset();
    this.refreshPanel();
  }

  private async retryTracker(): Promise<void> {
    const streamId = this.tracker.lastSnapshot?.streamId ?? this.spatial.streamId;
    if (!streamId) return;
    this.cancelUnfinished();
    const result = await postTrackerConfig({ expectedStreamId: streamId, retry: true });
    if (!result.ok) this.toasts.show(result.error, 'error');
    else {
      this.tracker.lastSnapshot = result.snapshot;
      this.trackerConfig = result.snapshot.config;
    }
    this.refreshPanel();
  }

  private refreshPanel(): void {
    const hud = this.spatial.hudState(this.nowMs || performance.now());
    const capturing = this.spatial.calibration.phase === 'collecting';
    const labels: Record<string, string> = {
      origin: 'Origin needed',
      tracked: 'Tracking',
      held: this.spatial.reason ? `Paused (${this.spatial.reason})` : 'Paused',
      lost: 'Lost',
      acquiring: 'Acquiring',
    };
    const captureStatus = capturing
      ? `Hold still… ${this.spatial.calibration.samples.length}/${CALIBRATION_MIN_SAMPLES}`
      : this.cameraState === 'error'
        ? this.tracker.lastStatus?.message ?? 'Camera error'
        : labels[hud] ?? hud;
    this.panel.update({
      source: this.trackerConfig.source,
      target: this.trackerConfig.target,
      colorPreset: this.trackerConfig.colorPreset,
      colorTolerance: this.trackerConfig.colorTolerance,
      scale: this.spatial.mapping.scale,
      calibrated: this.spatial.mapping.calibrated,
      depthaiInstalled: this.depthaiInstalled,
      status: captureStatus,
      applying: this.applyingTracker,
    });
  }

  private depthHudPlaneMode(): 'Auto' | 'Manual' | 'Locked' {
    if (!this.stroke) return this.planeMode === 'auto' ? 'Auto' : 'Manual';
    if (this.isDepthSource() && this.planeMode === 'auto' && this.depthBuffer && this.depthBuffer.state !== 'locked') {
      return 'Auto';
    }
    return 'Locked';
  }

  private depthHudPlaneReason(): string | null {
    if (!this.stroke) return REASON_LABELS[this.planeReason] ?? null;
    if (this.isDepthSource() && this.planeMode === 'auto' && this.depthBuffer && this.depthBuffer.state !== 'locked') {
      return REASON_LABELS[this.depthBuffer.state] ?? this.depthBuffer.state;
    }
    return 'locked';
  }

  private spatialHudLabel(): string {
    if (this.cameraState === 'error') return 'Camera error';
    const state = this.spatial.hudState(this.nowMs || performance.now());
    if (state === 'origin') return 'Origin needed';
    if (state === 'tracked') return 'Tracking';
    if (state === 'held') return 'Paused';
    if (state === 'lost') return 'Lost';
    return 'Acquiring';
  }

  // ---------------------------------------------------------------- strokes

  private computeSnap(cursorPx: Vec2): SnapResult {
    const plane = this.stroke ? this.stroke.plane : this.plane;
    return snapCursor({
      cursor: cursorPx,
      projector: this.viewport.projector(),
      plane,
      targets: { vertices: this.sketch.vertices(), midpoints: this.sketch.midpoints(), segments: this.sketch.segments() },
      gridStep: this.stroke ? this.strokeGridStep : this.gridStep,
      gridEnabled: this.gridEnabled,
      strokeStart: this.stroke ? this.stroke.start.world : null,
      axisLock: this.stroke ? this.axisLock : null,
      tolerancePx: SNAP_TOLERANCE_PX,
    });
  }

  private inferenceContext(cursorPx: Vec2, snap: SnapResult) {
    return {
      currentPlane: this.plane,
      projector: this.viewport.projector(),
      cursor: cursorPx,
      viewDirection: this.viewport.viewDirection(),
      snap,
      entities: this.sketch.all,
    };
  }

  private updatePlaneInference(nowMs: number): void {
    if (this.planeMode === 'manual') {
      this.planeReason = 'manual';
      return;
    }
    if (this.isDepthSource()) {
      this.planeReason = 'stroke';
      return;
    }
    if (
      this.mode !== 'READY' ||
      this.orbit.transitioning ||
      this.help.visible ||
      this.measure.isOpen ||
      this.cursor.isLost ||
      !this.cursor.position ||
      this.palmNavMode
    ) {
      return;
    }
    const snap = this.computeSnap(this.cursor.position);
    const choice = this.inference.update(this.inferenceContext(this.cursor.position, snap), nowMs);
    const through = planeThroughSnap(choice.plane, snap);
    this.plane = through;
    this.planeReason = through !== choice.plane ? snap.type : choice.reason;
  }

  private beginStroke(): void {
    if (this.stroke || !this.cursor.position) return;
    if (this.help.visible || this.measure.isOpen || this.cursor.isLost) return;
    this.orbit.cancelTransition(true);
    const position = this.cursor.position;
    const snap = this.computeSnap(position);
    let plane = this.plane;
    if (this.planeMode === 'auto') {
      const choice = this.inference.update(this.inferenceContext(position, snap), this.nowMs);
      plane = choice.plane;
      this.planeReason = choice.reason;
    }
    // The work plane always passes through the anchor; starting on a vertex,
    // midpoint or edge moves it there so a wall drawn from a floor edge
    // stands on the floor.
    const through = planeThroughSnap(plane, snap);
    const anchorMoved = through !== plane;
    plane = through;
    this.plane = plane;
    const projector = this.viewport.projector();
    const ray = projector.ray(position);
    const objectStart = isObjectSnap(snap);
    const hit = plane.intersectRay(ray.origin, ray.dir);
    if ((!hit || Math.abs(dot(ray.dir, plane.normal)) < 0.15) && !objectStart && !this.axisLock) {
      this.toasts.show('Plane is edge-on; A for Auto or Tab / 1 / 2 / 3', 'error');
      return;
    }
    this.gridStep = adaptiveGridStep(projector, plane, objectStart ? snap.world : hit ?? plane.anchor, GRID_MIN_PX);
    this.strokeGridStep = this.gridStep;
    const resnap = this.computeSnap(position);
    const start: SnapResult = { ...resnap, plane: plane.toPlane(resnap.world), onPlane: plane.contains(resnap.world, 1e-6) };
    this.stroke = new StrokeSession(plane, start, anchorMoved);
    this.resolutionCache = null;
    this.hover = null;
    this.sketchRenderer.setHover(null);
    if (anchorMoved) this.toasts.show(`Plane ${plane.label} moved through the snapped point`);
  }

  /**
   * React to a cursor update (hand frame or mouse move) immediately, so pen
   * deltas and stroke sampling do not depend on the render frame rate.
   */
  private onCursorMoved(): void {
    const position = this.cursor.position;
    if (!position) return;
    if (this.cursor.isLost || this.help.visible || this.measure.isOpen) {
      this.previousCursor = null;
      return;
    }
    this.synchronizeNavigation(false);
    const mode = this.mode;
    if (mode === 'ORBIT' || mode === 'PAN') {
      this.applyNavigationDelta(position);
      return;
    }
    this.sampleStroke();
  }

  private applyNavigationDelta(position: Vec2): void {
    const mode = this.mode;
    if (mode !== 'ORBIT' && mode !== 'PAN') return;
    if (
      this.isDepthSource() &&
      this.cursorSourceTag !== 'mouse' &&
      !this.holdSources.has('mouse:orbit') &&
      !this.holdSources.has('mouse:pan')
    ) {
      const pixel = this.spatial.pixel;
      if (!pixel) {
        this.pixelNavLast = null;
        return;
      }
      if (this.pixelNavLast) {
        const dx = pixel[0] - this.pixelNavLast[0];
        const dy = pixel[1] - this.pixelNavLast[1];
        if (mode === 'ORBIT') this.orbit.orbit(dx, dy, this.sketch.center());
        else this.orbit.pan(dx, dy);
      }
      this.pixelNavLast = [pixel[0], pixel[1]];
      return;
    }
    if (this.previousCursor) {
      const dx = position.x - this.previousCursor.x;
      const dy = position.y - this.previousCursor.y;
      if (mode === 'ORBIT') this.orbit.orbit(dx, dy, this.sketch.center());
      else this.orbit.pan(dx, dy);
    }
    this.previousCursor = { ...position };
  }

  /** Capture the current cursor into the active stroke; tracking loss pauses capture. */
  private sampleStroke(): void {
    if (this.isDepthSource()) {
      this.samplePlanarDepthStroke();
      return;
    }
    const stroke = this.stroke;
    const position = this.cursor.position;
    if (!stroke || !position || this.cursor.isLost) return;
    const snap = this.computeSnap(position);
    stroke.add(snap, snap.raw, position, 2);
  }

  private resolveFor(stroke: StrokeSession): StrokeResolution {
    const cache = this.resolutionCache;
    if (
      cache &&
      cache.session === stroke &&
      cache.revision === stroke.revision &&
      cache.sketchRev === this.sketchRevision &&
      cache.cameraRev === this.cameraRevision &&
      cache.gridStep === this.strokeGridStep &&
      cache.gridEnabled === this.gridEnabled
    ) {
      return cache.resolution;
    }
    const resolution = this.isDepthSource()
      ? this.resolveSpatial(stroke)
      : resolveStroke(stroke, {
          projector: this.viewport.projector(),
          vertices: this.sketch.vertices(),
          tolerancePx: SNAP_TOLERANCE_PX,
          gridStep: this.gridEnabled ? this.strokeGridStep : 0,
          entities: this.sketch.all,
        });
    this.resolutionCache = {
      session: stroke,
      revision: stroke.revision,
      sketchRev: this.sketchRevision,
      cameraRev: this.cameraRevision,
      gridStep: this.strokeGridStep,
      gridEnabled: this.gridEnabled,
      resolution,
    };
    return resolution;
  }

  private endStroke(): void {
    let stroke = this.stroke;
    if (!stroke) return;
    if (this.isDepthSource() && this.spatial.world) {
      const magnet = this.planarDepthSnap(this.spatial.world, stroke.plane, { magnet: SPATIAL_MAGNET });
      stroke.add(magnet, magnet.raw, magnet.screen, 0, 0);
    } else {
      this.sampleStroke();
    }
    if (this.isDepthSource() && this.depthBuffer && this.depthBuffer.state !== 'locked') {
      if (this.spatial.world) this.depthBuffer.append(this.spatial.world, this.spatial.mapping.scale);
      stroke = this.applyChosenDepthPlane(this.spatial.world, true) ?? stroke;
    }
    this.stroke = null;
    this.depthBuffer = null;
    this.sketchRenderer.setGhost(null, false, null);
    this.sketchRenderer.setInk(null);
    const minExtent = this.isDepthSource() ? 5 * this.spatial.mapping.scale : MIN_STROKE_PX;
    const extent = this.isDepthSource() ? stroke.worldExtent() : stroke.screenExtent();
    if (extent < minExtent) {
      this.resolutionCache = null;
      return;
    }

    const resolution = this.resolveFor(stroke);
    this.resolutionCache = null;
    this.lastRecognition = {
      reason: resolution.reason,
      points: stroke.planePoints(),
      screenExtent: stroke.screenExtent(),
    };
    if (resolution.status !== 'ready') {
      if (resolution.status === 'unrecognized') {
        this.sketchRenderer.fadeOut(stroke.worldPath());
        this.toasts.show('Not recognized: draw a straight line or a closed rectangle', 'error');
      } else {
        this.toasts.show(resolution.reason, 'info');
      }
      return;
    }
    const commit = this.commands.commitStroke(resolution.input, resolution.removeIds);
    if (!commit.ok) {
      this.toasts.show(commit.error, 'error');
      return;
    }
    this.lastCommitted = commit.entity;
    this.sketchRenderer.setLastLabel(commit.entity);
    this.plane = stroke.plane.withAnchor(anchorAfterCommit(resolution.input));
    this.toasts.show(commit.message, 'success');
    if (
      this.isDepthSource() &&
      commit.entity.type === 'line' &&
      resolution.reason === 'plane-locked line'
    ) {
      const inPlane = snapInPlaneAngle(commit.entity.a, commit.entity.b, stroke.plane.kind);
      if (inPlane.angleDeg != null) this.openAnglePrompt(commit.entity, stroke.plane.kind, inPlane.angleDeg);
    }
  }

  private cancelStroke(): void {
    this.stroke = null;
    this.depthBuffer = null;
    this.resolutionCache = null;
    this.sketchRenderer.setGhost(null, false, null);
    this.sketchRenderer.setInk(null);
    this.toasts.show('Stroke cancelled');
    this.synchronizeNavigation(false);
  }

  private cancelInteraction(): void {
    this.cancelUnfinished();
    this.holdSources.clear();
    this.held.clear();
    this.navMode = null;
    this.mouse.releaseAll(false);
    this.previousCursor = null;
    this.endOrbitGesture(false);
    this.orbit.cancelTransition(false);
    this.endPalmNav(false);
    this.inference.reset();
  }

  private applyGhost(resolution: StrokeResolution): void {
    if (resolution.status !== 'ready') {
      this.sketchRenderer.setGhost(null, false, null);
      return;
    }
    const input = resolution.input;
    const fake: Entity =
      input.type === 'line'
        ? { id: 'ghost', type: 'line', a: input.a, b: input.b }
        : { id: 'ghost', type: 'rect', corners: input.corners };
    const shared = resolution.reason === 'shared-border rectangle' || resolution.reason === 'assembled rectangle';
    this.sketchRenderer.setGhost(entityPoints(fake), fake.type === 'rect', {
      text: `${entityLabel(fake)}${shared ? ' · shared border' : ''}`,
      at: entityCenter(fake),
    });
  }

  private updateGhost(stroke: StrokeSession): void {
    if (this.depthBuffer?.state === 'pending') {
      this.sketchRenderer.setInk(this.depthBuffer.polyline(this.spatial.world ?? undefined));
      this.sketchRenderer.setGhost(null, false, null);
      return;
    }
    this.sketchRenderer.setInk(stroke.worldPath());
    this.applyGhost(this.resolveFor(stroke));
  }

  // ---------------------------------------------------------------- frame loop

  private frame(time: number): void {
    requestAnimationFrame((next) => this.frame(next));
    this.nowMs = time;
    this.orbit.update(time);
    const cursorPx = this.cursor.position;
    const projector = this.viewport.projector();
    const viewDirection = this.viewport.viewDirection();
    const mode = this.mode;

    this.updatePlaneInference(time);

    const cursorRay = cursorPx ? projector.ray(cursorPx) : null;
    const cursorHit = cursorRay ? this.plane.intersectRay(cursorRay.origin, cursorRay.dir) : null;
    const reference: Vec3 = this.stroke ? this.stroke.start.world : cursorHit ?? this.plane.anchor;
    this.gridStep = this.stroke ? this.strokeGridStep : adaptiveGridStep(projector, this.plane, reference, GRID_MIN_PX);

    const snap: SnapResult | null = cursorPx ? this.computeSnap(cursorPx) : null;

    if (this.stroke) {
      this.updateGhost(this.stroke);
    } else if (this.isDepthSource() && this.spatial.world && mode === 'READY') {
      this.updateSpatialHover(this.spatial.world);
    } else {
      const hovered = snap && mode === 'READY' ? this.hoveredEntity(snap) : null;
      if (hovered !== this.hover) {
        this.hover = hovered;
        this.sketchRenderer.setHover(hovered);
      }
    }

    const displayedPlane = this.stroke ? this.stroke.plane : planeThroughSnap(this.plane, snap);
    const focus =
      snap && isObjectSnap(snap)
        ? displayedPlane.toPlane(snap.world)
        : snap?.onPlane
          ? snap.plane
          : displayedPlane.toPlane(displayedPlane.anchor);
    this.planeVisual.setVisible(true);
    this.planeVisual.update(displayedPlane, this.gridStep, focus);
    const spatialWorld = this.isDepthSource() ? this.spatial.world : null;
    const spatialScreen = spatialWorld ? projector.project(spatialWorld) : null;
    if (this.isDepthSource()) {
      const preview = this.spatialPreview;
      const cursorWorld = preview?.world ?? spatialWorld;
      this.spatialVisual.update(cursorWorld, !!spatialWorld && !!spatialScreen, {
        workspace: WORKSPACE_CUBE_MM * this.spatial.mapping.scale,
        radius: cursorWorld ? this.spatialRadius(cursorWorld, this.stroke ? 1 : SPATIAL_MAGNET) : 4,
        snapType: preview?.type ?? 'free',
        target: preview && isSpatialObjectSnap(preview) ? preview.world : null,
      });
      const glyphSnap = spatialWorld
        ? {
            type: (this.spatialPreview?.type ?? 'free') as SnapResult['type'],
            world: this.spatialPreview?.world ?? spatialWorld,
            plane: displayedPlane.toPlane(this.spatialPreview?.world ?? spatialWorld),
            screen: spatialScreen ?? cursorPx ?? { x: 0, y: 0 },
            onPlane: displayedPlane.contains(this.spatialPreview?.world ?? spatialWorld, 1e-6),
            raw: spatialWorld,
          }
        : null;
      this.glyph.update(spatialScreen ? glyphSnap : null, spatialScreen, this.isDrawing());
    } else {
      this.spatialVisual.update(null, false);
      this.glyph.update(snap, cursorPx, !!this.stroke);
    }
    this.sketchRenderer.tick(time);

    this.hud.update({
      mode,
      plane: displayedPlane.info,
      planeMode: this.depthHudPlaneMode(),
      planeReason: this.depthHudPlaneReason(),
      snap: (this.isDepthSource() ? this.spatialPreview?.type ?? null : snap?.type) ?? null,
      snapAxis: this.isDepthSource() ? this.spatialPreview?.axis ?? null : snap?.axis ?? null,
      gridStep: this.isDepthSource() ? this.spatial.mapping.scale * 5 : this.gridStep,
      gridEnabled: this.isDepthSource() ? this.depthGridEnabled : this.gridEnabled,
      tracking: this.cursor.tracking,
      connection: this.connection,
      camera: this.cameraState,
      projection: this.viewport.ortho ? 'Ortho' : 'Persp',
      navAssist: this.navAssist,
      edgeOn: displayedPlane.isEdgeOn(viewDirection),
      entityCount: this.sketch.size,
      depthMode: this.isDepthSource(),
      spatialLabel: this.isDepthSource() ? this.spatialHudLabel() : null,
      scale: this.isDepthSource() ? this.spatial.mapping.scale : null,
      trackingAgeMs: this.isDepthSource() && this.spatial.last?.ageMs !== undefined ? this.spatial.last.ageMs : null,
    });
    this.hud.setKeys(this.keyHints(mode));

    this.viewport.render();
    this.triad.render(this.viewport, this.orbit);
  }

  /**
   * Entity under the cursor.  Vertices are often shared (a roof line ends on a
   * wall corner); prefer the entity that was just committed so L / Delete act
   * on what the user drew last.
   */
  private hoveredEntity(snap: SnapResult): Entity | null {
    if (!snap.entityId) return null;
    const last = this.lastCommitted ? this.sketch.get(this.lastCommitted.id) : undefined;
    if (last && last.id !== snap.entityId && (snap.type === 'vertex' || snap.type === 'midpoint')) {
      const shared = [...entityVertices(last), ...entityMidpoints(last)].some((v) => nearlyEqual(v.point, snap.world, 1e-6));
      if (shared) return last;
    }
    return this.sketch.get(snap.entityId) ?? null;
  }

  private keyHints(mode: Mode): KeyHint[] {
    const key = (action: PressAction | HoldAction) => labelForAction(action, this.platform);
    if (this.measure.isOpen) return [{ key: 'Enter', label: 'apply' }, { key: 'Esc', label: 'cancel' }];
    switch (mode) {
      case 'DRAWING':
        return [
          { key: key('draw'), label: 'release to commit' },
          { key: 'X / Y / Z', label: 'hold to lock axis' },
          { key: key('cancel'), label: 'cancel stroke' },
        ];
      case 'ORBIT':
        return [{ key: key('orbit'), label: 'move to orbit · release to stop' }];
      case 'PAN':
        return [{ key: key('pan'), label: 'move to pan · release to stop' }];
      default: {
        const hints: KeyHint[] = [
          { key: key('draw'), label: 'draw' },
          { key: key('orbit'), label: 'orbit' },
          { key: key('pan'), label: 'pan' },
          { key: key('toggleAutoPlane'), label: this.planeMode === 'auto' ? 'auto plane' : 'manual plane' },
          { key: key('cyclePlane'), label: 'pin plane' },
          { key: '1 2 3 0', label: 'views' },
        ];
        if (this.hover) hints.push({ key: key('measure'), label: `size ${entityLabel(this.hover)}` }, { key: key('delete'), label: 'delete' });
        else if (this.sketch.size) hints.push({ key: key('measure'), label: 'size' }, { key: key('undo'), label: 'undo' });
        hints.push({ key: key('export'), label: 'FreeCAD' }, { key: key('help'), label: 'help' });
        return hints;
      }
    }
  }

  /** Programmatic surface for automation, tests and future voice/AI agents. */
  get api(): AirCadApi {
    return {
      sketch: this.sketch,
      commands: this.commands,
      plane: () => this.plane,
      planeMode: () => this.planeMode,
      project: (world) => this.viewport.projector().project(world),
      ray: (screen) => this.viewport.projector().ray(screen),
      press: (action) => this.doPress(action),
      hold: (action, down) => this.setHold(action, down),
      setCursor: (point) => {
        if (this.cursor.updateMouse(point, performance.now() / 1000)) {
          this.noteCursorSource('mouse');
          this.onCursorMoved();
        }
      },
      lastRecognition: () => this.lastRecognition,
      setDrawingSpace: (space) => this.setDrawingSpace(space),
      setTrackerSource: (source) => {
        this.trackerConfig = { ...this.trackerConfig, source };
        if (source === 'oak') this.applyDepthScalePreset();
        else this.depthScaleApplied = false;
        this.refreshPanel();
      },
      setSpatialOrigin: (cameraMm) => {
        this.spatial.mapping.setOrigin(cameraMm);
        this.refreshPanel();
      },
      setDepthScale: (scale) => this.changeScale(scale),
      mappingScale: () => this.spatial.mapping.scale,
      pushSpatial: (message) => this.onSpatial(message),
    };
  }
}

export interface AirCadApi {
  sketch: Sketch;
  commands: Commands;
  plane(): WorkPlane;
  planeMode(): PlaneMode;
  project(world: Vec3): Vec2 | null;
  ray(screen: Vec2): { origin: Vec3; dir: Vec3 };
  press(action: PressAction): void;
  hold(action: HoldAction, down: boolean): void;
  setCursor(point: Vec2): void;
  /** Reason and plane points of the most recent pen-up, for diagnostics. */
  lastRecognition(): { reason: string; points: Vec2[]; screenExtent: number } | null;
  setDrawingSpace(space: string): void;
  setTrackerSource(source: TrackerSource): void;
  setSpatialOrigin(cameraMm: Vec3): void;
  setDepthScale(scale: number): void;
  mappingScale(): number;
  pushSpatial(message: SpatialMessage): void;
}

declare global {
  interface Window {
    aircad?: AirCadApi;
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');
window.aircad = new App(root).api;
