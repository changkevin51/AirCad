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
import { nextPlaneKind, WorkPlane, type Axis, type PlaneKind } from './model/plane';
import { PlaneInference, type PlaneMode } from './model/plane-inference';
import { adaptiveGridStep, DEFAULT_SNAP_TOLERANCE_PX, snapCursor, type SnapResult } from './model/snap';
import { joinEndpoints } from './model/spatial-join';
import { alignLineToWorldAxis, preferKindsFromEntity } from './model/spatial-plane-fit';
import {
  gridStepForScale,
  hybridRadius,
  objectRadius,
  SpatialSnapper,
  SPATIAL_MAGNET,
  SPATIAL_SCREEN_TOLERANCE_PX,
  type SpatialSnapResult,
} from './model/spatial-snap';
import { SpatialStrokeSession } from './model/spatial-stroke';
import { describeEntity, entityCenter, entityMidpoints, entityPoints, entityVertices, Sketch, type Entity } from './model/sketch';
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
import { InputPanel, type DrawingSpace } from './ui/input-panel';
import { MeasureInput } from './ui/measure-input';
import { CameraPip } from './ui/pip';
import { Toasts } from './ui/toast';

const SNAP_TOLERANCE_PX = DEFAULT_SNAP_TOLERANCE_PX;
const MIN_STROKE_PX = 6;
const SPATIAL_STALL_MS = 300;
const WORKSPACE_CUBE_MM = 400;
const DEPTH_SCALE_STORAGE_KEY = 'aircad.depthScale';
const DEFAULT_DEPTH_SCALE = 10;
const SPATIAL_FIT_EXTENT_MM = 60;

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
  private spatialStroke: SpatialStrokeSession | null = null;
  private spatialPreview: SpatialSnapResult | null = null;
  private drawingSpace: DrawingSpace = 'free3d';
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
  private fittedPlaneLabel: string | null = null;

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
      onDrawingSpace: (space) => this.setDrawingSpace(space),
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
    return !!this.stroke || !!this.spatialStroke;
  }

  private isDepthSource(): boolean {
    return this.trackerConfig.source === 'oak';
  }

  private cancelUnfinished(): void {
    if (this.spatialStroke) this.cancelSpatialStroke('Stroke cancelled');
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
      this.sampleSpatialStroke();
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
      if (this.spatialStroke) this.endSpatialStroke();
      else this.endStroke();
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
        if (!this.isDepthSource() || this.drawingSpace === 'planar') {
          this.setPlaneKind(PLANE_FOR_VIEW[preset], false);
          this.pinManual();
          this.toasts.show(`${preset[0].toUpperCase()}${preset.slice(1)} view · plane ${this.plane.label}`);
        } else {
          this.toasts.show(`${preset[0].toUpperCase()}${preset.slice(1)} view`);
        }
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
        if (this.isDepthSource() && this.drawingSpace === 'free3d') {
          this.toasts.show('Choose Planar in the input panel before changing the work plane');
          break;
        }
        this.setPlaneKind(nextPlaneKind(this.plane.kind), true);
        this.pinManual();
        break;
      case 'toggleAutoPlane': {
        if (this.isDepthSource() && this.drawingSpace === 'free3d') {
          this.toasts.show('Choose Planar in the input panel before using Auto plane');
          break;
        }
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
    if (this.drawingSpace === 'planar') this.samplePlanarDepthStroke();
    else this.sampleSpatialStroke();
    this.refreshPanel();
  }

  private beginDepthStroke(): void {
    if (this.isDrawing()) return;
    if (this.drawingSpace === 'planar') {
      this.beginPlanarDepthStroke();
      return;
    }
    const identity = this.spatial.identity();
    if (!this.spatial.mapping.calibrated) {
      this.toasts.show('Set the origin (O) before drawing', 'error');
      return;
    }
    if (!identity || !this.spatial.world || !this.spatialReady()) {
      this.toasts.show('Wait for a tracked point before drawing', 'error');
      return;
    }
    this.orbit.cancelTransition(true);
    const snap = this.computeSpatialSnap(this.spatial.world, { magnet: SPATIAL_MAGNET });
    this.spatialStroke = new SpatialStrokeSession(snap, identity, this.nowMs || performance.now());
    this.spatialPreview = snap;
    this.hover = null;
    this.sketchRenderer.setHover(null);
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
    return this.spatialSnapper.snap({
      raw: world,
      targets: { vertices: this.sketch.vertices(), midpoints: this.sketch.midpoints(), segments: this.sketch.segments() },
      scale: this.spatial.mapping.scale,
      gridEnabled: this.depthGridEnabled,
      start: this.spatialStroke?.start.world ?? null,
      axisLock: this.spatialStroke ? this.axisLock : null,
      project: (point) => this.viewport.projector().project(point),
      worldPerPixel: this.spatialWorldPerPixel(world),
      magnet: options.magnet ?? 1,
      prefer: this.lastEndpoint(),
    });
  }

  private resolveSpatial(session: StrokeSession): StrokeResolution {
    const scale = this.spatial.mapping.scale;
    const world = this.spatialStroke?.current.world ?? session.last.world;
    const wpp = this.spatialWorldPerPixel(world);
    const radius = this.spatialRadius(world, SPATIAL_MAGNET);
    const tolerancePx = wpp > 0 ? Math.max(SNAP_TOLERANCE_PX, radius / wpp) : SNAP_TOLERANCE_PX;
    return resolveStroke(session, {
      projector: this.viewport.projector(),
      vertices: this.sketch.vertices(),
      tolerancePx,
      gridStep: this.depthGridEnabled ? gridStepForScale(scale) : 0,
      entities: this.sketch.all,
    });
  }

  private preferFitKinds(): PlaneKind[] {
    return this.lastCommitted ? preferKindsFromEntity(this.lastCommitted) : [];
  }

  private applyDepthScalePreset(): void {
    if (this.trackerConfig.source !== 'oak' || this.depthScaleApplied) return;
    this.spatial.mapping.setScale(loadStoredDepthScale(), this.spatial.cameraMm);
    this.depthScaleApplied = true;
  }

  private sampleSpatialStroke(): void {
    const session = this.spatialStroke;
    if (!session) return;
    const now = this.nowMs || performance.now();
    const identity = this.spatial.identity();
    const fresh = !!identity && this.spatialReady(now) && !!this.spatial.world;
    if (!fresh || !identity || !this.spatial.world) {
      session.pause(now);
      if (session.isDead(now)) this.cancelSpatialStroke('Tracking lost; stroke cancelled');
      return;
    }
    const snap = this.computeSpatialSnap(this.spatial.world);
    if (!session.update(snap, identity, true, now, this.spatial.mapping.scale)) {
      if (session.isDead(now)) this.cancelSpatialStroke('Tracking jumped; stroke cancelled');
      return;
    }
    this.spatialPreview = snap;
  }

  private endSpatialStroke(): void {
    const session = this.spatialStroke;
    if (!session) return;
    const now = this.nowMs || performance.now();
    this.sampleSpatialStroke();
    const identity = this.spatial.identity();
    if (this.spatial.world && identity) {
      const magnet = this.computeSpatialSnap(this.spatial.world, { magnet: SPATIAL_MAGNET });
      session.update(magnet, identity, true, now, this.spatial.mapping.scale);
    }
    session.closeLoop(this.spatialRadius(session.current.world, SPATIAL_MAGNET));
    this.spatialStroke = null;
    this.fittedPlaneLabel = null;
    this.sketchRenderer.setGhost(null, false, null);
    this.sketchRenderer.setInk(null);
    if (session.status !== 'active' || session.paused || !this.spatialReady(now)) {
      this.toasts.show('Stroke cancelled: tracking was not fresh', 'error');
      return;
    }
    if (!session.canCommit(this.spatial.mapping.scale)) return;

    const fitted = session.fitted(this.preferFitKinds());
    const targets = { vertices: this.sketch.vertices(), segments: this.sketch.segments() };
    const joinRadius = objectRadius(this.spatial.mapping.scale) * SPATIAL_MAGNET;

    if (fitted.straight && !fitted.planar) {
      const bothObject = isSpatialObjectSnap(session.start) && isSpatialObjectSnap(session.current);
      const aligned = bothObject
        ? { a: session.start.world, b: session.current.world, axis: null as 'x' | 'y' | 'z' | null }
        : alignLineToWorldAxis(session.start.world, session.current.world);
      const input = joinEndpoints({ type: 'line', a: aligned.a, b: aligned.b }, targets, joinRadius);
      this.lastRecognition = {
        reason: aligned.axis ? 'axis-aligned line' : 'line',
        points: fitted.session.planePoints(),
        screenExtent: fitted.session.screenExtent(),
      };
      const commit = this.commands.commitStroke(input);
      if (!commit.ok) {
        this.toasts.show(commit.error, 'error');
        return;
      }
      this.lastCommitted = commit.entity;
      this.sketchRenderer.setLastLabel(commit.entity);
      this.toasts.show(commit.message, 'success');
      return;
    }

    const resolution = this.resolveSpatial(fitted.session);
    if (resolution.status !== 'ready') {
      this.lastRecognition = {
        reason: resolution.reason,
        points: fitted.session.planePoints(),
        screenExtent: fitted.session.screenExtent(),
      };
      if (resolution.status === 'unrecognized') {
        this.sketchRenderer.fadeOut(session.polyline());
        this.toasts.show('Not recognized: draw a straight line or a closed rectangle', 'error');
      } else {
        this.toasts.show(resolution.reason, 'info');
      }
      return;
    }
    let input = resolution.input;
    let reason = resolution.reason;
    if (input.type === 'line') {
      const bothObject = isSpatialObjectSnap(session.start) && isSpatialObjectSnap(session.current);
      if (!bothObject) {
        const aligned = alignLineToWorldAxis(input.a, input.b);
        if (aligned.axis) {
          input = { type: 'line', a: aligned.a, b: aligned.b };
          reason = 'axis-aligned line';
        }
      }
    }
    input = joinEndpoints(input, targets, joinRadius);
    this.lastRecognition = {
      reason,
      points: fitted.session.planePoints(),
      screenExtent: fitted.session.screenExtent(),
    };
    const commit = this.commands.commitStroke(input, resolution.removeIds);
    if (!commit.ok) {
      this.toasts.show(commit.error, 'error');
      return;
    }
    this.lastCommitted = commit.entity;
    this.sketchRenderer.setLastLabel(commit.entity);
    this.plane = this.plane.withAnchor(anchorAfterCommit(input));
    this.toasts.show(commit.message, 'success');
  }

  private cancelSpatialStroke(message = 'Stroke cancelled'): void {
    this.spatialStroke = null;
    this.spatialPreview = null;
    this.fittedPlaneLabel = null;
    this.sketchRenderer.setGhost(null, false, null);
    this.sketchRenderer.setInk(null);
    this.toasts.show(message);
    this.synchronizeNavigation(false);
  }

  private beginPlanarDepthStroke(): void {
    if (this.stroke || !this.spatial.mapping.calibrated || !this.spatial.world || !this.spatialReady()) {
      this.toasts.show('Need a calibrated, tracked point to draw on the plane', 'error');
      return;
    }
    this.orbit.cancelTransition(true);
    const world = this.spatial.world;
    let plane = this.plane;
    const object = this.computeSpatialSnap(world);
    if (object.type === 'vertex' || object.type === 'midpoint' || object.type === 'edge') {
      plane = plane.contains(object.world, 1e-6) ? plane : plane.withAnchor(object.world);
    }
    this.plane = plane;
    const snap = this.planarDepthSnap(world, plane);
    this.strokeGridStep = this.spatial.mapping.scale * 5;
    this.stroke = new StrokeSession(plane, snap, false);
    this.resolutionCache = null;
    if (plane.isEdgeOn(this.viewport.viewDirection())) {
      this.toasts.show(`Work plane ${plane.label} is edge-on in this view`, 'info');
    }
  }

  /** Project the measured world point onto the locked plane; never a screen-region ray. */
  private planarDepthSnap(world: Vec3, plane: WorkPlane): SnapResult {
    const object = this.computeSpatialSnap(world);
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
    const stroke = this.stroke;
    if (!stroke || !this.isDepthSource() || this.drawingSpace !== 'planar') return;
    if (!this.spatial.world || !this.spatialReady()) return;
    const snap = this.planarDepthSnap(this.spatial.world, stroke.plane);
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

  private setDrawingSpace(space: DrawingSpace): void {
    this.cancelUnfinished();
    this.drawingSpace = space;
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
      drawingSpace: this.drawingSpace,
      scale: this.spatial.mapping.scale,
      calibrated: this.spatial.mapping.calibrated,
      depthaiInstalled: this.depthaiInstalled,
      status: captureStatus,
      applying: this.applyingTracker,
    });
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
    if (
      this.mode !== 'READY' ||
      this.orbit.transitioning ||
      this.help.visible ||
      this.measure.isOpen ||
      this.cursor.isLost ||
      !this.cursor.position ||
      this.palmNavMode ||
      (this.isDepthSource() && this.drawingSpace === 'free3d')
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
    if (this.isDepthSource() && this.drawingSpace === 'planar') {
      this.samplePlanarDepthStroke();
      return;
    }
    const stroke = this.stroke;
    const position = this.cursor.position;
    if (!stroke || !position || this.cursor.isLost) return;
    const snap = this.computeSnap(position);
    const minWorld =
      this.isDepthSource() && this.drawingSpace === 'planar' ? Math.max(1, this.spatial.mapping.scale) : undefined;
    stroke.add(snap, snap.raw, position, 2, minWorld);
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
    const resolution = resolveStroke(stroke, {
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
    const stroke = this.stroke;
    if (!stroke) return;
    this.sampleStroke();
    this.stroke = null;
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
    this.plane = this.plane.withAnchor(anchorAfterCommit(resolution.input));
    this.toasts.show(commit.message, 'success');
  }

  private cancelStroke(): void {
    this.stroke = null;
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

    if (this.isDepthSource() && this.lastSpatialAt && time - this.lastSpatialAt > SPATIAL_STALL_MS) {
      if (this.spatialStroke) this.spatialStroke.pause(time);
      if (this.spatialStroke?.isDead(time)) this.cancelSpatialStroke('Tracking stalled; stroke cancelled');
    }

    this.updatePlaneInference(time);

    const cursorRay = cursorPx ? projector.ray(cursorPx) : null;
    const cursorHit = cursorRay ? this.plane.intersectRay(cursorRay.origin, cursorRay.dir) : null;
    const reference: Vec3 = this.stroke ? this.stroke.start.world : cursorHit ?? this.plane.anchor;
    this.gridStep = this.stroke ? this.strokeGridStep : adaptiveGridStep(projector, this.plane, reference, GRID_MIN_PX);

    const snap: SnapResult | null = cursorPx ? this.computeSnap(cursorPx) : null;

    if (this.spatialStroke) {
      const points = this.spatialStroke.polyline();
      this.sketchRenderer.setInk(points);
      const scale = this.spatial.mapping.scale;
      if (this.spatialStroke.worldExtent() >= SPATIAL_FIT_EXTENT_MM * scale) {
        const fitted = this.spatialStroke.fitted(this.preferFitKinds());
        this.fittedPlaneLabel = fitted.plane.label;
        if (fitted.straight && !fitted.planar) {
          const bothObject = isSpatialObjectSnap(this.spatialStroke.start) && isSpatialObjectSnap(this.spatialStroke.current);
          const aligned = bothObject
            ? this.spatialStroke.preview()
            : alignLineToWorldAxis(this.spatialStroke.start.world, this.spatialStroke.current.world);
          const { a, b } = aligned;
          this.sketchRenderer.setGhost([a, b], false, {
            text: `${Math.round(this.spatialStroke.length())} mm`,
            at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
          });
        } else {
          this.applyGhost(this.resolveSpatial(fitted.session));
          this.sketchRenderer.setInk(points);
        }
      } else {
        this.fittedPlaneLabel = null;
        const { a, b } = this.spatialStroke.preview();
        const delta = this.spatialStroke.delta();
        this.sketchRenderer.setGhost([a, b], false, {
          text: `${Math.round(this.spatialStroke.length())} mm  Δ ${Math.round(delta.x)} ${Math.round(delta.y)} ${Math.round(delta.z)}`,
          at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
        });
      }
    } else if (this.stroke) {
      // Points are captured in onCursorMoved; the ghost follows the camera too.
      this.updateGhost(this.stroke);
    } else {
      const hovered = snap && mode === 'READY' ? this.hoveredEntity(snap) : null;
      if (hovered !== this.hover) {
        this.hover = hovered;
        this.sketchRenderer.setHover(hovered);
      }
    }

    const fittedLive = this.spatialStroke && this.fittedPlaneLabel ? this.spatialStroke.fitted(this.preferFitKinds()) : null;
    const displayedPlane = this.stroke
      ? this.stroke.plane
      : fittedLive
        ? fittedLive.plane
        : planeThroughSnap(this.plane, snap);
    const focus =
      snap && isObjectSnap(snap)
        ? displayedPlane.toPlane(snap.world)
        : snap?.onPlane
          ? snap.plane
          : displayedPlane.toPlane(displayedPlane.anchor);
    const hidePlane = this.isDepthSource() && this.drawingSpace === 'free3d' && !this.stroke && !fittedLive;
    this.planeVisual.setVisible(!hidePlane);
    if (!hidePlane) this.planeVisual.update(displayedPlane, this.gridStep, focus);
    const spatialWorld = this.isDepthSource() ? this.spatial.world : null;
    const spatialScreen = spatialWorld ? projector.project(spatialWorld) : null;
    if (this.isDepthSource()) {
      const preview = this.spatialPreview;
      const cursorWorld = preview?.world ?? spatialWorld;
      this.spatialVisual.update(cursorWorld, !!spatialWorld && !!spatialScreen, {
        workspace: WORKSPACE_CUBE_MM * this.spatial.mapping.scale,
        radius: cursorWorld ? this.spatialRadius(cursorWorld, this.spatialStroke ? 1 : SPATIAL_MAGNET) : 4,
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
      planeMode: this.stroke ? 'Locked' : this.isDepthSource() && this.drawingSpace === 'free3d' ? 'Manual' : this.planeMode === 'auto' ? 'Auto' : 'Manual',
      planeReason: this.stroke ? 'locked' : REASON_LABELS[this.planeReason] ?? null,
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
      drawingSpace: this.isDepthSource() ? this.drawingSpace : null,
      spatialLabel: this.isDepthSource() ? this.spatialHudLabel() : null,
      scale: this.isDepthSource() ? this.spatial.mapping.scale : null,
      trackingAgeMs: this.isDepthSource() && this.spatial.last?.ageMs !== undefined ? this.spatial.last.ageMs : null,
      fittedPlane: this.spatialStroke ? this.fittedPlaneLabel : null,
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
  setDrawingSpace(space: DrawingSpace): void;
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
