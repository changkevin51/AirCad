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
import { Commands, parseDepth, type CommandResult } from './model/commands';
import { ExtrusionSession } from './model/extrusion';
import { defaultFaceIndex, pickProfileFace, profileFaces } from './model/faces';
import { pickFace } from './model/pick';
import { PLANES, nextPlaneKind, WorkPlane, type Axis, type PlaneKind } from './model/plane';
import { polygonFrame } from './model/polygon';
import { PlaneInference, type PlaneMode } from './model/plane-inference';
import {
  chooseStrokePlane,
  DepthStrokeBuffer,
  DEPTH_PLANE_LOCK_MM,
  rebuildPlanarSession,
  spatialToSnapResult,
} from './model/depth-plane-lock';
import { inferStrokeEdges, type GuidedStrokeResolution } from './model/edge-inference';
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
import {
  describeEntity,
  entityCenter,
  entityMidpoints,
  entityPoints,
  entityScaleHandles,
  entityVertices,
  formatMm,
  isExtrudableProfile,
  isRectangleProfile,
  isTriangleProfile,
  rectFrame,
  scaleEntity,
  translateEntity,
  Sketch,
  type Entity,
  type EntityInput,
  type ExtrusionEntity,
  type SolidEntity,
  type ScaleHandle,
  type TriangleEntity,
} from './model/sketch';
import { anchorAfterCommit, resolveStroke, StrokeSession, type LineMeasurement, type StrokeResolution } from './model/stroke';
import { add, closestPointOnLineToRay, distance, distance2, dot, isFinite3, length2, nearlyEqual, normalize2, roundTo, scale, sub, sub2, v2, v3, type Vec2, type Vec3 } from './model/vec';
import { entityLabel, SketchRenderer } from './render/sketch-renderer';
import { AxisTriad, createGroundGrid } from './scene/grid';
import { OrbitController, type ViewPreset } from './scene/orbit';
import { SpatialCursorVisual } from './scene/spatial-cursor-visual';
import { Viewport } from './scene/viewport';
import { WorkPlaneVisual } from './scene/workplane-visual';
import { AppBar, CommandBar, type CommandCallbacks } from './ui/command-bar';
import { CursorGlyph } from './ui/cursor-glyph';
import { openDialog } from './ui/dialog';
import { HelpOverlay, type HelpSection } from './ui/help';
import { Hud, type KeyHint, type Mode } from './ui/hud';
import { InputPanel } from './ui/input-panel';
import { Inspector } from './ui/inspector';
import { MeasureInput } from './ui/measure-input';
import { ModelBrowser } from './ui/model-browser';
import { CameraPip } from './ui/pip';
import { Toasts } from './ui/toast';
import { ViewControls } from './ui/view-controls';
import { WorkspaceShell, type InspectorTab } from './ui/workspace';
import {
  entityLabel as entityName,
  pressAvailability,
  workPlaneAvailability,
  type ExtrusionSnapshot,
  type UiActionResult,
  type UiSnapshot,
  type WorkspaceAction,
} from './ui/workspace-state';
import { captureVoiceTarget, dispatchVoiceCommand, sameVoiceTarget, type VoiceTarget } from './voice/commands';
import { VoiceControl } from './voice/control';

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

function sameSolidPreview(a: SolidEntity, b: SolidEntity): boolean {
  if (a.type !== b.type || a.depth !== b.depth) return false;
  return a.corners.every((corner, index) => nearlyEqual(corner, b.corners[index], 1e-6));
}

interface MoveSession {
  entity: Entity;
  preview: Entity;
  offset: Vec3;
  grab: { point: Vec3; offset: Vec3; plane: WorkPlane; step: number } | null;
  source: string | null;
  needsRelease: boolean;
}

interface ScaleSession {
  entity: Entity;
  preview: Entity;
  factor: number;
  handle: ScaleHandle | null;
  grab: { offset: Vec2; along: number; factor: number; step: number } | null;
  source: string | null;
  needsRelease: boolean;
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
  private readonly shell: WorkspaceShell;
  private readonly hud: Hud;
  private readonly toasts: Toasts;
  private readonly help: HelpOverlay;
  private readonly pip: CameraPip;
  private readonly measure: MeasureInput;
  private readonly glyph: CursorGlyph;
  private readonly panel: InputPanel;
  private readonly appBar: AppBar;
  private readonly commandBar: CommandBar;
  private readonly viewControls: ViewControls;
  private readonly browser: ModelBrowser;
  private readonly inspector: Inspector;
  private readonly viewportElement: HTMLElement;
  private lastUiSignature = '';
  /** Inspector auto-opened for Push/Pull; restored on Apply/Cancel unless the user touched it. */
  private inspectorOpenedForExtrusion = false;
  private readonly spatialVisual = new SpatialCursorVisual();
  private readonly spatialSnapper = new SpatialSnapper();
  private readonly clockSync: ClockSync;
  private readonly spatial: SpatialCursorSource;
  private readonly inference = new PlaneInference();
  private readonly voice: VoiceControl;

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
    resolution: GuidedStrokeResolution;
  } | null = null;
  private sketchRevision = 0;
  private cameraRevision = 0;
  private cursorSourceTag: 'hand' | 'mouse' | null = null;
  private lastHandId: number | null = null;
  private previousCursor: Vec2 | null = null;
  private extrusion: ExtrusionSession | null = null;
  private movement: MoveSession | null = null;
  private scaling: ScaleSession | null = null;
  private selectedId: string | null = null;
  private lastPinching = false;
  private lastHandMessageAt = 0;
  private focused = true;
  private planeBeforeStroke: WorkPlane | null = null;
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
  private modelRevision = 0;
  private lastSnap: SnapResult | null = null;
  private voiceCapture: { target: VoiceTarget; revision: number; cursor: Vec2 | null; snap: SnapResult | null } | null = null;

  constructor(root: HTMLElement) {
    this.shell = new WorkspaceShell(root);
    const regions = this.shell.regions;
    const viewportElement = regions.viewport;
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
    this.hud = new Hud(regions.statusBar, regions.viewportOverlay, { onHelp: () => this.doPress('help') });
    this.glyph = new CursorGlyph(regions.viewportOverlay);
    this.toasts = new Toasts(regions.notifications);
    this.pip = new CameraPip(regions.cameraPreview);
    this.measure = new MeasureInput(regions.dialogs);
    this.help = new HelpOverlay(regions.dialogs, this.platform);
    this.panel = new InputPanel(regions.input, {
      onSource: (source) => void this.applyTracker({ ...this.trackerConfig, source }),
      onTarget: (target) => void this.applyTracker({ ...this.trackerConfig, target }),
      onColorPreset: (colorPreset) => void this.applyTracker({ ...this.trackerConfig, colorPreset }),
      onColorTolerance: (colorTolerance) => void this.applyTracker({ ...this.trackerConfig, colorTolerance }),
      onScale: (scale) => this.changeScale(scale),
      onSetOrigin: () => this.beginCalibration('origin'),
      onRecenter: () => this.beginCalibration('recenter'),
      onFitWorkspace: () => this.fitWorkspace(),
      onRetry: () => void this.retryTracker(),
      onToggleNavAssist: () => this.doPress('toggleNavAssist'),
      onTogglePip: () => this.doPress('togglePip'),
      onCancelInteraction: () => this.cancelInteraction(),
      onReleaseFocus: () => this.focusViewport(),
    });
    this.refreshPanel();

    const commands: CommandCallbacks = {
      dispatch: (action) => this.dispatchWorkspaceAction(action),
      togglePanel: (panel) => {
        if (panel === 'inspector') this.inspectorOpenedForExtrusion = false;
        this.shell.setLayout(
          panel === 'browser' ? { browserVisible: !this.shell.layout.browserVisible } : { inspectorVisible: !this.shell.layout.inspectorVisible },
        );
      },
      openInspectorTab: (tab: InspectorTab) => {
        this.inspectorOpenedForExtrusion = false;
        this.shell.setLayout({ inspectorVisible: true, inspectorTab: tab });
      },
      openHelp: (section?: HelpSection) => {
        if (this.stroke) this.cancelStroke();
        this.extrusion?.pause();
        this.help.show(section);
        this.synchronizeNavigation(false);
      },
      requestClear: () => this.confirmClear(),
      focusViewport: () => this.focusViewport(),
    };
    this.appBar = new AppBar(regions.appBar, commands);
    this.commandBar = new CommandBar(regions.commandBar, commands);
    this.viewControls = new ViewControls(regions.viewControls, commands);
    const surface = { dispatch: commands.dispatch, flash: (text: string, tone?: 'info' | 'success') => this.hud.flash(text, tone) };
    this.browser = new ModelBrowser(regions.modelBrowser, surface);
    this.inspector = new Inspector(regions.inspector, surface);
    this.shell.setEntityCount(0);

    this.shell.onLayoutChange(() => this.onLayoutChange());

    // Entering chrome (pointer or keyboard focus) ends any gesture safely:
    // cancel an unfinished stroke, pause extrusion, release held sources.
    const chromeInput = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[data-cad-ui]')) this.cancelInteraction();
    };
    root.addEventListener?.('pointerdown', chromeInput, true);
    root.addEventListener?.('focusin', chromeInput);

    this.voice = new VoiceControl(regions.viewportOverlay, {
      capture: () => this.captureVoiceOperation(),
      isCurrent: (target) => this.isVoiceOperationCurrent(target),
      execute: (command, target) => this.executeVoiceCommand(command, target),
      notify: (message, error) => this.toasts.show(message, error ? 'error' : 'success', 6000),
    });

    this.sketch.onChange(() => {
      this.sketchRevision++;
      this.modelRevision += 1;
      this.sketchRenderer.setSketch(this.sketch.drawable.filter((entity) => entity.id !== this.extrusion?.profile.id));
      if (this.selectedId && !this.sketch.get(this.selectedId) && !this.sketch.getProfile(this.selectedId)) this.selectedId = null;
      this.sketchRenderer.setSelected(this.extrusion ? null : this.selected);
      this.hover = null;
      this.sketchRenderer.setHover(null);
      if (this.extrusion && this.sketch.getProfile(this.extrusion.profile.id) !== this.extrusion.profile) this.cancelExtrusion();
      if (this.lastCommitted && !this.sketch.get(this.lastCommitted.id)) this.lastCommitted = this.sketch.last ?? null;
      this.sketchRenderer.setLastLabel(this.lastCommitted && this.sketch.get(this.lastCommitted.id) ? this.sketch.get(this.lastCommitted.id)! : null);
      this.shell.setEntityCount(this.sketch.size);
      this.publishUi();
      if (this.movement) {
        if (this.sketch.get(this.movement.entity.id) !== this.movement.entity) this.cancelMove();
        else this.renderMove();
      }
      if (this.scaling) {
        if (this.sketch.get(this.scaling.entity.id) !== this.scaling.entity) this.cancelScale();
        else this.renderScale();
      }
    });
    this.viewport.onResize(() => { this.cameraRevision++; this.pauseMove(false); this.pauseScale(false); });

    this.mouse = new MouseSource(viewportElement, {
      onMove: (point) => {
        if (this.cursor.updateMouse(point, performance.now() / 1000)) {
          this.noteCursorSource('mouse');
          this.onCursorMoved();
        }
      },
      onHold: (action, down) => this.setHold(action, down, `mouse:${action}`),
      onWheel: (factor, point) => {
        if (!this.voiceCapture && !this.extrusion?.dragging && !this.movement?.grab && !this.scaling?.grab) {
          this.pauseMove(false);
          this.pauseScale(false);
          this.zoomAtCursor(factor, point);
        }
      },
      onCancel: () => this.cancelInteraction(),
    });

    this.tracker = new TrackerClient(defaultTrackerUrl(), {
      onHands: (message) => this.onHands(message),
      onThumb: (message) => this.pip.setThumb(message),
      onSpatial: (message) => this.onSpatial(message),
      onStatus: (message) => {
        this.cameraState = message.camera;
        this.pip.setCameraState(this.cameraState, this.connection === 'open', message.message);
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
          if (this.stroke) this.cancelStroke();
          if (this.extrusion) this.cancelExtrusion();
          this.clockSync.reset();
          this.extrusion?.pause();
          this.pauseMove();
          this.pauseScale();
          this.previousCursor = null;
        }
        this.pip.setCameraState(this.cameraState, state === 'open');
        this.refreshPanel();
      },
      // The snapshot is the server's ground truth for source/camera state;
      // adopt it so a --no-camera server never leaves the UI claiming webcam.
      onSnapshot: (snapshot) => {
        if (this.applyingTracker) return;
        this.trackerConfig = { ...snapshot.config };
        this.cameraState = snapshot.camera;
        this.pip.setSource(snapshot.config.source);
        this.pip.setCameraState(snapshot.camera, this.connection === 'open', snapshot.message);
        this.refreshPanel();
      },
    });
    this.tracker.connect();

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.onKeyUp(event));
    window.addEventListener('blur', () => {
      this.focused = false;
      this.cancelInteraction();
    });
    window.addEventListener('focus', () => {
      this.focused = true;
    });
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (globalThis.document.hidden) {
        this.focused = false;
        this.cancelInteraction();
      }
    });
    viewportElement.focus();

    requestAnimationFrame((time) => this.frame(time));
  }

  // ---------------------------------------------------------------- input

  /**
   * CAD shortcuts are ignored when the event target sits inside docked UI
   * chrome (any `[data-cad-ui]` region) or while the measure dialog is open.
   * This replaces the old tag-name allowlist so buttons, menus, tabs and
   * forms all keep their native keyboard behavior.
   */
  private isChromeTarget(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    // A chrome handler can remove its own target mid-dispatch (e.g. the
    // model browser deleting its focused row); a detached node no longer
    // reaches [data-cad-ui], so treat it as chrome unless it is the canvas.
    if (target !== this.viewportElement && target.isConnected === false) return true;
    return typeof target.closest === 'function' && !!target.closest('[data-cad-ui]');
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
    if (this.movement) this.cancelMove();
    if (this.scaling) this.cancelScale();
    if (this.stroke) this.cancelStroke();
    if (this.extrusion) this.cancelExtrusion();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.isChromeTarget(event) || this.measure.isOpen) return;
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
    this.focused = true;
    if (this.voiceCapture) {
      if (!down) this.holdSources.delete(source);
      this.held.clear();
      for (const heldAction of this.holdSources.values()) this.held.add(heldAction);
      return;
    }
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
      if (this.navMode === 'orbit') this.endOrbitGesture(false);
      this.navMode = null;
      this.previousCursor = null;
      if (this.scaling) {
        this.updateScale();
        return;
      }
      if (this.movement) {
        this.updateMove();
        return;
      }
      if (this.extrusion) {
        this.updateExtrusion();
        return;
      }
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
    if (this.cursor.position) this.previousCursor = { ...this.cursor.position };
    if (action === 'orbit' || action === 'pan') {
      this.extrusion?.pause(false);
      this.pauseMove(false);
      this.pauseScale(false);
    }
  }

  private endHold(action: HoldAction): void {
    if (action === 'draw') {
      if (this.scaling) {
        this.updateScale();
        return;
      }
      if (this.movement) {
        this.updateMove();
        return;
      }
      if (this.extrusion) {
        this.updateExtrusion();
        return;
      }
      this.endStroke();
      this.synchronizeNavigation(false);
      return;
    }
    this.pixelNavLast = null;
    this.synchronizeNavigation(action === 'orbit');
    if ((action === 'orbit' || action === 'pan') && this.navMode && this.cursor.position) {
      this.previousCursor = { ...this.cursor.position };
    }
    if (this.extrusion) this.updateExtrusion();
    if (this.movement) this.updateMove();
    if (this.scaling) this.updateScale();
  }

  private synchronizeNavigation(allowSettle = false): void {
    const blocked =
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
    if (desired) {
      this.extrusion?.pause(false);
      this.pauseMove(false);
      this.pauseScale(false);
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

  private voiceReady(): boolean {
    return this.focused && !this.navigationMode && !this.measure.isOpen && !this.help.visible;
  }

  private captureVoiceOperation(): VoiceTarget {
    if (this.voiceCapture) {
      if (!this.isVoiceOperationCurrent(this.voiceCapture.target)) throw new Error('Operation or geometry changed; cancel the draft and start again');
      return this.voiceCapture.target;
    }
    this.sampleStroke();
    const target = captureVoiceTarget(this.stroke, this.extrusion, this.voiceReady());
    this.voiceCapture = {
      target, revision: this.modelRevision,
      cursor: this.cursor.position ? { ...this.cursor.position } : null,
      snap: this.lastSnap ? structuredClone(this.lastSnap) : null,
    };
    this.extrusion?.pause();
    this.previousCursor = null;
    this.holdSources.clear();
    this.held.clear();
    this.mouse.releaseAll();
    return target;
  }

  private isVoiceOperationCurrent(target: VoiceTarget): boolean {
    if (!this.voiceCapture || this.voiceCapture.target !== target || this.voiceCapture.revision !== this.modelRevision) return false;
    try {
      return sameVoiceTarget(target, captureVoiceTarget(this.stroke, this.extrusion, this.voiceReady()));
    } catch {
      return false;
    }
  }

  private executeVoiceCommand(command: unknown, target: VoiceTarget): CommandResult {
    if (!this.isVoiceOperationCurrent(target)) {
      return { ok: false, error: 'Operation or geometry changed; cancel the draft and start again' };
    }
    let current: VoiceTarget;
    try {
      current = captureVoiceTarget(this.stroke, this.extrusion, this.voiceReady());
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Invalid voice command' };
    }
    const result = dispatchVoiceCommand(command, target, this.commands, current, () => {
      this.voiceCapture = null;
      this.stroke = null;
      this.extrusion = null;
      this.planeBeforeStroke = null;
      this.sketchRenderer.setInk(null);
      this.sketchRenderer.setLineGuide(null, null);
      this.sketchRenderer.setGhost(null, false, null);
      this.sketchRenderer.setExtrusion(null);
      this.sketchRenderer.setActiveFace(null);
      this.holdSources.clear();
      this.held.clear();
      this.mouse.releaseAll();
    });
    if (result.ok) {
      this.lastCommitted = result.entity;
      this.plane = this.plane.withAnchor(anchorAfterCommit(result.entity));
      this.selectEntity(result.entity);
      this.sketchRenderer.setLastLabel(result.entity);
      this.sketchRenderer.setSketch(this.sketch.drawable);
    }
    return result;
  }

  private get axisLock(): Axis | null {
    for (const action of ['lockX', 'lockY', 'lockZ'] as const) if (this.held.has(action)) return LOCK_AXES[action] ?? null;
    return null;
  }

  private get cursorSource(): string | null {
    if (this.cursor.isLost) return null;
    const hand = this.cursor.hand;
    return hand ? `hand:${hand.id}` : this.cursor.tracking === 'mouse' ? 'mouse' : null;
  }

  private get navigationMode(): 'ORBIT' | 'PAN' | null {
    return this.held.has('orbit') ? 'ORBIT' : this.held.has('pan') ? 'PAN' : null;
  }

  private get mode(): Mode {
    if (this.navMode === 'orbit') return 'ORBIT';
    if (this.navMode === 'pan') return 'PAN';
    if (this.scaling) return 'SCALING';
    if (this.movement) return 'MOVING';
    if (this.extrusion) return 'EXTRUDING';
    if (this.isDrawing()) return 'DRAWING';
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
    this.lastHandMessageAt = now;
    const trackingBefore = this.cursor.tracking;
    this.cursor.updateHands(message, { w: this.viewport.width, h: this.viewport.height }, now);
    // Tracking transitions are rare; keep the Input tab's status line honest.
    if (this.cursor.tracking !== trackingBefore) this.refreshPanel();
    const hasHand = this.cursor.tracking === 'hand' && !!this.cursor.hand;
    if (hasHand) {
      this.noteCursorSource('hand');
      this.onCursorMoved();
    } else if (this.cursor.isLost) {
      this.synchronizeNavigation(false);
      this.extrusion?.pause();
      this.pauseMove();
      this.pauseScale();
    }
    const pinching = this.cursor.hand?.pinching ?? false;
    if (this.focused && this.cursor.hand && pinching && !this.lastPinching && this.mode === 'READY' && !this.measure.isOpen && !this.help.visible) {
      this.selectAtCursor();
    }
    if (this.cursor.hand) this.lastPinching = pinching;
    this.pip.setHands(message, this.cursor.handId);
    const navAllowed =
      this.navAssist &&
      hasHand &&
      this.focused &&
      !this.held.has('draw') &&
      !this.held.has('orbit') &&
      !this.held.has('pan') &&
      !this.isDrawing() &&
      !this.extrusion &&
      !this.movement &&
      !this.scaling &&
      !pinching &&
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
    this.focused = true;
    if ((this.help.visible || this.measure.isOpen) && action !== 'help' && action !== 'cancel') return;
    if (this.voiceCapture && action !== 'voice' && action !== 'cancel' && action !== 'togglePip') {
      this.toasts.show('Voice distance pending: V to send/retry, Esc to cancel');
      return;
    }
    if (action === 'export') {
      void this.exportToFreeCad();
      return;
    }
    if (this.isDrawing() && BLOCKED_WHILE_DRAWING.has(action)) return;
    if (this.isDrawing() && CANCEL_STROKE_FIRST.has(action)) this.cancelUnfinished();
    if (this.scaling && !['scale', 'confirm', 'cancel', 'help', 'togglePip', 'cyclePlane', 'toggleGrid', 'viewIso', 'viewTop', 'viewFront', 'viewRight', 'toggleProjection', 'fitAll', 'zoomIn', 'zoomOut'].includes(action)) {
      this.toasts.show('Finish scaling with Enter or R, or cancel with Esc');
      return;
    }
    const rebaseScale = !!this.scaling && ['cyclePlane', 'toggleGrid', 'viewIso', 'viewTop', 'viewFront', 'viewRight', 'toggleProjection', 'fitAll', 'zoomIn', 'zoomOut'].includes(action);
    if (rebaseScale) this.pauseScale(false);
    if (this.movement && !['move', 'confirm', 'cancel', 'help', 'togglePip', 'cyclePlane', 'toggleGrid', 'viewIso', 'viewTop', 'viewFront', 'viewRight', 'toggleProjection', 'fitAll', 'zoomIn', 'zoomOut'].includes(action)) {
      this.toasts.show('Finish the move with Enter or M, or cancel with Esc');
      return;
    }
    const rebaseMove = !!this.movement && ['cyclePlane', 'toggleGrid', 'viewIso', 'viewTop', 'viewFront', 'viewRight', 'toggleProjection', 'fitAll', 'zoomIn', 'zoomOut'].includes(action);
    if (rebaseMove) this.pauseMove(false);
    if (this.extrusion && !['extrude', 'confirm', 'cancel', 'measure', 'help', 'togglePip', 'cyclePlane', 'viewIso', 'viewTop', 'viewFront', 'viewRight', 'toggleProjection', 'zoomIn', 'zoomOut', 'voice'].includes(action)) {
      this.toasts.show('Finish the extrusion with Enter, or cancel with Esc');
      return;
    }
    if (this.extrusion && ['viewIso', 'viewTop', 'viewFront', 'viewRight', 'toggleProjection', 'zoomIn', 'zoomOut'].includes(action)) this.extrusion.pause();
    switch (action) {
      case 'select':
        if (!this.stroke) this.selectAtCursor();
        break;
      case 'move':
        if (this.movement) this.commitMove();
        else this.beginMove();
        break;
      case 'scale':
        if (this.scaling) this.commitScale();
        else this.beginScale();
        break;
      case 'extrude':
        if (this.extrusion) this.commitExtrusion();
        else this.beginExtrusion();
        break;
      case 'confirm':
        if (this.scaling) this.commitScale();
        else if (this.movement) this.commitMove();
        else if (this.extrusion) this.commitExtrusion();
        break;
      case 'viewTop':
      case 'viewFront':
      case 'viewRight': {
        const preset = action === 'viewTop' ? 'top' : action === 'viewFront' ? 'front' : 'right';
        this.orbit.setView(preset, true, this.nowMs);
        this.setPlaneKind(PLANE_FOR_VIEW[preset], false);
        this.pinManual();
        this.hud.flash(`${preset[0].toUpperCase()}${preset.slice(1)} view · plane ${this.plane.label}`);
        break;
      }
      case 'viewIso':
        this.orbit.setView('iso', true, this.nowMs);
        this.hud.flash('Isometric view');
        break;
      case 'toggleProjection':
        this.hud.flash(this.orbit.toggleProjection() ? 'Orthographic' : 'Perspective');
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
        if (this.extrusion) {
          if (this.extrusion.cycleFace()) this.hud.flash(`Extruding ${this.extrusion.face.label} face`);
          else this.hud.flash('Release to switch faces');
          this.sketchRenderer.setActiveFace(this.extrusion.face);
        } else {
          this.setPlaneKind(nextPlaneKind(this.plane.kind), true);
          this.pinManual();
        }
        break;
      case 'toggleAutoPlane': {
        this.planeMode = this.planeMode === 'auto' ? 'manual' : 'auto';
        if (this.planeMode === 'manual') {
          this.planeReason = 'manual';
          this.hud.flash(`Plane ${this.plane.label} pinned · A returns to auto`);
        } else {
          this.inference.reset();
          this.hud.flash('Automatic work plane');
        }
        break;
      }
      case 'toggleGrid':
        if (this.isDepthSource()) {
          this.depthGridEnabled = !this.depthGridEnabled;
          this.hud.flash(`Depth grid snap ${this.depthGridEnabled ? 'on' : 'off'}`);
        } else {
          this.gridEnabled = !this.gridEnabled;
          this.sampleStroke();
          this.hud.flash(`Grid snap ${this.gridEnabled ? 'on' : 'off'}`);
        }
        break;
      case 'toggleNavAssist':
        if (this.isDepthSource()) {
          this.toasts.show('Palm navigation is not available with the depth camera');
          break;
        }
        this.navAssist = !this.navAssist;
        if (!this.navAssist) this.endPalmNav(false);
        this.hud.flash(`Palm navigation ${this.navAssist ? 'on: one open palm orbits, two palms pan/zoom' : 'off'}`);
        this.publishUi();
        break;
      case 'setOrigin':
        this.beginCalibration('origin');
        break;
      case 'recenter':
        this.beginCalibration('recenter');
        break;
      case 'undo': {
        const label = this.commands.undo();
        this.hud.flash(label ? `Undo ${label}` : 'Nothing to undo');
        break;
      }
      case 'redo': {
        const label = this.commands.redo();
        this.hud.flash(label ? `Redo ${label}` : 'Nothing to redo');
        break;
      }
      case 'delete': {
        const target = this.selected ?? this.hover ?? this.sketch.last;
        const result = target ? this.commands.deleteEntity(target.id) : this.commands.deleteLast();
        if (result.ok) this.hud.flash(result.message);
        else this.toasts.show(result.error, 'error');
        if (result.ok) this.hover = null;
        break;
      }
      case 'clear': {
        const count = this.commands.clear();
        this.hud.flash(count ? `Cleared ${count} entities` : 'Sketch is already empty');
        this.plane = new WorkPlane(this.plane.kind);
        this.inference.reset();
        break;
      }
      case 'cancel':
        if (this.voiceCapture) {
          this.voiceCapture = null;
          this.voice.cancel();
          this.sketchRenderer.setLineGuide(null, null);
          this.hud.flash('Voice draft cancelled');
        } else if (this.help.visible) this.help.hide();
        else if (this.scaling) this.cancelScale();
        else if (this.movement) this.cancelMove();
        else if (this.extrusion) this.cancelExtrusion();
        else if (this.isDrawing()) this.cancelUnfinished();
        else this.selectEntity(null);
        break;
      case 'voice':
        this.voice.toggle();
        break;
      case 'measure':
        this.openMeasure();
        break;
      case 'togglePip': {
        if (this.trackerConfig.source === 'none') {
          this.hud.flash('Camera preview needs a camera input');
          break;
        }
        const shown = this.pip.toggle();
        if (shown && !this.shell.layout.inspectorVisible) {
          this.inspectorOpenedForExtrusion = false;
          this.shell.setLayout({ inspectorVisible: true });
        }
        this.hud.flash(shown ? 'Camera preview on' : 'Camera preview off');
        this.publishUi();
        break;
      }
      case 'help':
        if (this.stroke) this.cancelStroke();
        this.extrusion?.pause();
        this.pauseMove();
        this.pauseScale();
        this.help.toggle();
        this.synchronizeNavigation(false);
        break;
    }
    if (rebaseMove) this.updateMove();
    if (rebaseScale) this.updateScale();
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
    if (announce) this.hud.flash(`Work plane ${this.plane.label}`);
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
    if (this.extrusion) {
      const session = this.extrusion;
      session.pause();
      this.held.delete('draw');
      this.measure.open(`Pull distance for the ${session.face.label} face (mm; negative pushes in):`, (text) =>
        this.dispatchWorkspaceAction({ type: 'setExtrusionPull', text }),
      );
      return;
    }
    const target = this.selected ?? this.hover ?? this.lastCommitted ?? this.sketch.last ?? null;
    if (!target) {
      this.toasts.show('Draw something first, then press L to set its size', 'error');
      return;
    }
    if (target.type === 'circle') {
      this.toasts.show('Circles are read-only; redraw the shape as a closed outline to edit it', 'error');
      return;
    }
    if (target.type === 'triangle') {
      this.toasts.show('Use Q to extrude the triangle or M to move it');
      return;
    }
    const prompt = target.type === 'line'
      ? `Length of ${describeEntity(target)} (mm):`
      : target.type === 'extrusion'
        ? isRectangleProfile(target.corners) ? 'Extrusion depth (mm) or base size (W x H mm):' : 'Extrusion depth (mm):'
        : target.type === 'prism'
          ? 'Triangular prism depth (mm; e.g. 100 or -10 cm):'
          : target.type === 'polygon' ? 'Extrusion depth (mm):' : `Size of ${describeEntity(target)} (W x H mm):`;
    this.cancelInteraction();
    this.measure.open(prompt, (text) => this.applyDimension(target.id, text));
  }

  // ----------------------------------------------------------- workspace chrome

  private uiContext(): UiSnapshot {
    const layout = this.shell.layout;
    return {
      drawing: this.isDrawing(),
      extruding: !!this.extrusion,
      entityCount: this.sketch.size,
      selected: this.selected,
      canUndo: this.sketch.canUndo,
      canRedo: this.sketch.canRedo,
      planeKind: this.plane.kind,
      planeMode: this.planeMode,
      gridEnabled: this.isDepthSource() ? this.depthGridEnabled : this.gridEnabled,
      gridStep: this.isDepthSource() ? this.spatial.mapping.scale * 5 : this.gridStep,
      ortho: this.viewport.ortho,
      inputLabel: this.inputLabel(),
      pipVisible: this.pip.visible,
      navAssist: this.navAssist,
      browserVisible: layout.browserVisible,
      inspectorVisible: layout.inspectorVisible,
      inspectorTab: layout.inspectorTab,
      extrusion: this.extrusionSnapshot(),
    };
  }

  /** Read the live session for the inspector's Push/Pull operation section. */
  private extrusionSnapshot(): ExtrusionSnapshot | null {
    const session = this.extrusion;
    if (!session) return null;
    const preview = session.preview;
    const frame = isRectangleProfile(preview.corners) ? rectFrame(preview) : polygonFrame(preview.corners);
    return {
      targetId: session.profile.id,
      targetLabel: entityName(session.profile),
      faces: session.currentFaces().map((face, index) => ({ index, label: face.label })),
      faceIndex: session.faceIndex,
      dragging: session.dragging,
      pull: session.pulled,
      depth: session.depth,
      baseWidth: frame?.width ?? 0,
      baseHeight: frame?.height ?? 0,
      previewValid: Math.abs(session.depth) >= 1e-6 && isExtrudableProfile(preview.corners),
    };
  }

  private inputLabel(): string {
    const source = this.trackerConfig.source;
    return source === 'oak' ? 'Depth camera' : source === 'webcam' ? 'Webcam' : 'Mouse';
  }

  private publishUi(): void {
    const snapshot = this.uiContext();
    this.appBar.update(snapshot);
    this.commandBar.update(snapshot);
    this.viewControls.update(snapshot);
    this.browser.update(this.sketch.all, this.selectedId, snapshot.extruding);
    this.inspector.update(snapshot);
  }

  /** Repaint chrome only when the snapshot actually changed. */
  private publishUiIfChanged(): void {
    const snapshot = this.uiContext();
    const signature = [
      snapshot.drawing,
      snapshot.extruding,
      snapshot.entityCount,
      snapshot.selected ? `${snapshot.selected.id}:${snapshot.selected.type}` : '',
      snapshot.canUndo,
      snapshot.canRedo,
      snapshot.planeKind,
      snapshot.planeMode,
      snapshot.gridEnabled,
      snapshot.gridStep,
      snapshot.ortho,
      snapshot.inputLabel,
      snapshot.browserVisible,
      snapshot.inspectorVisible,
      snapshot.inspectorTab,
      snapshot.pipVisible,
      snapshot.navAssist,
      this.sketchRevision,
      snapshot.extrusion
        ? `${snapshot.extrusion.faceIndex}:${snapshot.extrusion.dragging}:${snapshot.extrusion.pull}:${snapshot.extrusion.depth}:${snapshot.extrusion.previewValid}:${snapshot.extrusion.faces.length}`
        : '',
    ].join('|');
    if (signature === this.lastUiSignature) return;
    this.lastUiSignature = signature;
    this.publishUi();
  }

  /** Panel toggles and responsive band changes: never refit the camera. */
  private onLayoutChange(): void {
    if (this.stroke) this.cancelStroke();
    this.extrusion?.pause();
    this.inference.reset();
    this.publishUi();
  }

  /**
   * The typed action boundary used by the command surfaces.  UI-originated
   * presses apply the same availability predicates as the disabled buttons;
   * 'measure'/'extrude'/'delete' require an explicit selection with no
   * hovered/last fallback (keyboard paths keep their historical fallback).
   */
  dispatchWorkspaceAction(action: WorkspaceAction): UiActionResult {
    const ctx = this.uiContext();
    switch (action.type) {
      case 'press': {
        const availability = pressAvailability(action.action, ctx);
        if (!availability.enabled) return { ok: false, error: availability.reason ?? 'Unavailable' };
        this.doPress(action.action);
        return { ok: true };
      }
      case 'selectEntity': {
        if (ctx.drawing) return { ok: false, error: 'Finish the current stroke first.' };
        if (ctx.extruding) return { ok: false, error: 'Finish or cancel Push/Pull first.' };
        const entity = action.id ? this.sketch.get(action.id) ?? null : null;
        if (action.id && !entity) return { ok: false, error: 'That object no longer exists.' };
        this.selectEntity(entity);
        return { ok: true };
      }
      case 'setWorkPlane': {
        const availability = workPlaneAvailability(ctx);
        if (!availability.enabled) return { ok: false, error: availability.reason ?? 'Unavailable' };
        if (action.plane === 'auto') {
          this.planeMode = 'auto';
          this.planeReason = 'current';
          this.inference.reset();
        } else {
          this.setPlaneKind(action.plane, true);
          this.pinManual();
        }
        this.publishUi();
        return { ok: true };
      }
      case 'setDimension': {
        if (ctx.drawing) return { ok: false, error: 'Finish the current stroke first.' };
        if (ctx.extruding) return { ok: false, error: 'Finish or cancel Push/Pull first.' };
        // The inspector only ever edits the displayed (selected) entity.
        if (action.id !== this.selectedId || !this.sketch.get(action.id)) {
          return { ok: false, error: 'That object no longer exists.' };
        }
        return this.applyDimension(action.id, action.spec);
      }
      case 'setExtrusionFace': {
        const session = this.extrusion;
        if (!session) return { ok: false, error: 'No Push/Pull operation is active.' };
        if (session.dragging) return { ok: false, error: 'Release to switch faces' };
        if (!session.setFace(action.index)) return { ok: false, error: 'That face is not available.' };
        this.sketchRenderer.setExtrusion(session.preview);
        this.sketchRenderer.setActiveFace(session.face);
        this.publishUi();
        return { ok: true };
      }
      case 'setExtrusionPull': {
        const session = this.extrusion;
        if (!session) return { ok: false, error: 'No Push/Pull operation is active.' };
        const pull = parseDepth(action.text);
        if (pull === null) return { ok: false, error: 'Enter a non-zero distance such as 500, -250, or 2 m.' };
        session.setPull(pull);
        this.sketchRenderer.setExtrusion(session.preview);
        this.sketchRenderer.setActiveFace(session.face);
        this.publishUi();
        return { ok: true };
      }
    }
  }

  /**
   * Shared commit path for typed dimensions (measure dialog and inspector
   * forms): one undoable edit, last-committed anchor update, status flash.
   */
  private applyDimension(id: string, spec: string): UiActionResult {
    const result = this.commands.setDimension(id, spec);
    if (!result.ok) return { ok: false, error: result.error };
    this.lastCommitted = result.entity;
    this.plane = this.plane.withAnchor(anchorAfterCommit(result.entity));
    this.hud.flash(result.message, 'success');
    return { ok: true };
  }

  /** Visible Clear sketch: confirm first; keyboard/programmatic clear stays immediate. */
  private confirmClear(): void {
    if (!this.sketch.size) {
      this.hud.flash('Sketch is already empty');
      return;
    }
    this.cancelInteraction();
    const message = document.createElement('p');
    message.textContent = `Clear all ${this.sketch.size} object${this.sketch.size === 1 ? '' : 's'}? You can undo with Ctrl+Z.`;
    const body = document.createElement('div');
    body.appendChild(message);
    openDialog({
      host: this.shell.regions.dialogs,
      title: 'Clear sketch',
      body,
      backdropClose: false,
      actions: [
        { label: 'Cancel', onClick: () => undefined, focus: true },
        {
          label: 'Clear sketch',
          tone: 'danger',
          onClick: () => {
            this.doPress('clear');
          },
        },
      ],
      onClose: () => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body || active === document.documentElement) this.focusViewport();
      },
    });
  }

  // ----------------------------------------------------------- selection / extrusion

  private get selected(): Entity | null {
    if (!this.selectedId) return null;
    return this.sketch.get(this.selectedId) ?? this.sketch.getProfile(this.selectedId);
  }

  private resolveSelection(entity: Entity | null): Entity | null {
    return entity?.type === 'line' ? this.sketch.getProfile(entity.id) ?? entity : entity;
  }

  private entityAtCursor(): Entity | null {
    const position = this.cursor.position;
    if (!position || this.cursor.isLost) return null;
    return this.hoveredEntity(this.computeSnap(position)) ?? pickFace(this.sketch.drawable, position, this.viewport.projector());
  }

  private selectEntity(entity: Entity | null): void {
    const resolved = this.resolveSelection(entity);
    this.selectedId = resolved?.id ?? null;
    this.sketchRenderer.setSelected(resolved);
    this.publishUi();
  }

  private selectAtCursor(): void {
    const entity = this.entityAtCursor();
    this.selectEntity(entity);
    const shown = this.selected;
    if (shown) this.hud.flash(`Selected ${describeEntity(shown)}${shown.type !== 'line' && shown.type !== 'circle' ? ' · Q to push/pull' : ''}`);
  }

  private beginMove(): void {
    if (!this.focused || this.measure.isOpen || this.help.visible) return;
    if (this.stroke || this.navigationMode) {
      this.toasts.show('Finish drawing or navigating before moving a shape', 'error');
      return;
    }
    const entity = this.selected ?? this.entityAtCursor();
    if (!entity) {
      this.toasts.show('Select a shape with a click, pinch, or S, then press M to move it', 'error');
      return;
    }
    this.selectEntity(entity);
    this.movement = { entity, preview: entity, offset: v3(0, 0, 0), grab: null, source: null, needsRelease: false };
    this.hover = null;
    this.sketchRenderer.setHover(null);
    this.renderMove();
    this.updateMove();
    this.toasts.show(`Moving on ${this.plane.label} · pinch or drag to reposition · Enter / M applies · Esc cancels`, 'info', 6000);
  }

  private pauseMove(requireRelease = true): void {
    if (!this.movement) return;
    this.movement.grab = null;
    this.movement.needsRelease ||= requireRelease;
  }

  private renderMove(): void {
    const session = this.movement;
    if (!session) return;
    this.sketchRenderer.setSketch(this.sketch.all.map((entity) => entity.id === session.entity.id ? session.preview : entity));
    this.sketchRenderer.setSelected(session.preview);
    this.sketchRenderer.setLastLabel(session.preview);
  }

  private updateMove(): void {
    const session = this.movement;
    if (!session) return;
    const position = this.cursor.position;
    const source = this.cursorSource;
    if (!this.focused || this.measure.isOpen || this.help.visible || !position || !source) {
      this.pauseMove();
      return;
    }
    if (this.navigationMode) {
      this.pauseMove(false);
      return;
    }
    if (session.source !== null && session.source !== source) this.pauseMove();
    session.source = source;
    const gripping = this.held.has('draw') || !!this.cursor.hand?.pinching;
    if (!gripping) {
      session.grab = null;
      session.needsRelease = false;
      return;
    }
    if (session.needsRelease) return;
    const plane = session.grab?.plane ?? this.plane.withAnchor(entityCenter(session.preview));
    const ray = this.viewport.projector().ray(position);
    const point = plane.intersectRay(ray.origin, ray.dir);
    if (plane.isEdgeOn(this.viewport.viewDirection()) || !point || !isFinite3(point)) {
      this.pauseMove(false);
      return;
    }
    if (!session.grab) {
      session.grab = { point, offset: { ...session.offset }, plane, step: this.gridEnabled ? this.gridStep : 0 };
      return;
    }
    const delta = sub(point, session.grab.point);
    const step = session.grab.step;
    const offset = add(session.grab.offset, v3(roundTo(delta.x, step), roundTo(delta.y, step), roundTo(delta.z, step)));
    if (!isFinite3(offset) || nearlyEqual(offset, session.offset, 1e-6)) return;
    const preview = translateEntity(session.entity, offset);
    if (!entityPoints(preview).every(isFinite3)) return;
    session.offset = offset;
    session.preview = preview;
    this.renderMove();
  }

  private commitMove(): void {
    const session = this.movement;
    if (!session) return;
    this.movement = null;
    const result = this.commands.move(session.entity.id, session.offset);
    this.sketchRenderer.setSketch(this.sketch.all);
    this.holdSources.clear();
    this.held.clear();
    this.mouse.releaseAll();
    if (result.ok) {
      this.lastCommitted = result.entity;
      this.selectEntity(result.entity);
      this.sketchRenderer.setLastLabel(result.entity);
    } else {
      this.sketchRenderer.setSelected(this.selected);
      this.sketchRenderer.setLastLabel(this.selected);
    }
    this.toasts.show(result.ok ? result.message : result.error, result.ok ? 'success' : 'error');
  }

  private cancelMove(): void {
    this.movement = null;
    this.sketchRenderer.setSketch(this.sketch.all);
    this.sketchRenderer.setSelected(this.selected);
    this.sketchRenderer.setLastLabel(this.selected);
    this.holdSources.clear();
    this.held.clear();
    this.mouse.releaseAll();
    this.toasts.show('Move cancelled');
  }

  private beginScale(): void {
    if (!this.focused || this.measure.isOpen || this.help.visible) return;
    if (this.stroke || this.navigationMode) {
      this.toasts.show('Finish drawing or navigating before scaling a shape', 'error');
      return;
    }
    const entity = this.selected ?? this.entityAtCursor();
    if (!entity) {
      this.toasts.show('Select a shape with a click, pinch, or S, then press R to scale it', 'error');
      return;
    }
    this.selectEntity(entity);
    this.scaling = { entity, preview: entity, factor: 1, handle: null, grab: null, source: null, needsRelease: false };
    this.hover = null;
    this.sketchRenderer.setHover(null);
    this.renderScale();
    this.updateScale();
    this.toasts.show('Pinch or drag a corner to scale · opposite corner stays fixed · Enter / R applies · Esc cancels', 'info', 6000);
  }

  private pauseScale(requireRelease = true): void {
    if (!this.scaling) return;
    this.scaling.grab = null;
    this.scaling.needsRelease ||= requireRelease;
  }

  private renderScale(): void {
    const session = this.scaling;
    if (!session) return;
    this.sketchRenderer.setSketch(this.sketch.all.map((entity) => entity.id === session.entity.id ? session.preview : entity));
    this.sketchRenderer.setSelected(session.preview);
    this.sketchRenderer.setLastLabel(session.preview);
    const handle = session.handle;
    const point = handle ? add(handle.anchor, scale(sub(handle.point, handle.anchor), session.factor)) : null;
    this.sketchRenderer.setGhost(handle && point ? [handle.anchor, point] : null, false,
      handle ? { text: `${Number((session.factor * 100).toFixed(1))}% · fixed corner`, at: handle.anchor } : null);
  }

  private updateScale(): void {
    const session = this.scaling;
    if (!session) return;
    const position = this.cursor.position;
    const source = this.cursorSource;
    if (!this.focused || this.measure.isOpen || this.help.visible || !position || !source) {
      this.pauseScale();
      return;
    }
    if (this.navigationMode) {
      this.pauseScale(false);
      return;
    }
    if (session.source !== null && session.source !== source) this.pauseScale();
    session.source = source;
    const gripping = this.held.has('draw') || !!this.cursor.hand?.pinching;
    if (!gripping) {
      session.grab = null;
      session.needsRelease = false;
      return;
    }
    if (session.needsRelease) return;
    const projector = this.viewport.projector();
    if (!session.handle) {
      let nearest: { handle: ScaleHandle; distance: number } | null = null;
      for (const handle of entityScaleHandles(session.entity)) {
        const screen = projector.project(handle.point);
        if (!screen) continue;
        const d = distance2(position, screen);
        if (d <= SNAP_TOLERANCE_PX && (!nearest || d < nearest.distance)) nearest = { handle, distance: d };
      }
      if (!nearest) return;
      session.handle = nearest.handle;
      this.renderScale();
    }
    const { point, anchor } = session.handle;
    const direction = sub(point, anchor);
    const span = distance(point, anchor);
    const screen = projector.project(add(anchor, scale(direction, session.factor)));
    const anchorScreen = projector.project(anchor);
    const referenceScreen = projector.project(point);
    if (!screen || !anchorScreen || !referenceScreen || !Number.isFinite(span) || span < 1e-6 || distance2(referenceScreen, anchorScreen) < 2) {
      this.pauseScale(false);
      return;
    }
    const offset = session.grab?.offset ?? sub2(position, screen);
    const ray = projector.ray(sub2(position, offset));
    const hit = closestPointOnLineToRay(ray.origin, ray.dir, anchor, direction);
    if (!hit || !Number.isFinite(hit.s) || !isFinite3(hit.point) || dot(sub(hit.point, ray.origin), ray.dir) < 0) {
      this.pauseScale(false);
      return;
    }
    if (!session.grab) {
      session.grab = { offset, along: hit.s, factor: session.factor, step: this.gridEnabled ? this.gridStep : 0 };
      return;
    }
    const factor = session.grab.factor + roundTo(hit.s - session.grab.along, session.grab.step) / span;
    if (factor === session.factor) return;
    const preview = scaleEntity(session.entity, anchor, factor);
    if (!preview) return;
    session.factor = factor;
    session.preview = preview;
    this.renderScale();
  }

  private commitScale(): void {
    const session = this.scaling;
    if (!session) return;
    this.scaling = null;
    const result = this.commands.scale(session.entity.id, session.handle?.anchor ?? entityCenter(session.entity), session.factor);
    this.sketchRenderer.setGhost(null, false, null);
    this.sketchRenderer.setSketch(this.sketch.all);
    this.holdSources.clear();
    this.held.clear();
    this.mouse.releaseAll();
    if (result.ok) {
      this.lastCommitted = result.entity;
      this.selectEntity(result.entity);
      this.sketchRenderer.setLastLabel(result.entity);
    } else {
      this.sketchRenderer.setSelected(this.selected);
      this.sketchRenderer.setLastLabel(this.selected);
    }
    this.toasts.show(result.ok ? result.message : result.error, result.ok ? 'success' : 'error');
  }

  private cancelScale(): void {
    this.scaling = null;
    this.sketchRenderer.setGhost(null, false, null);
    this.sketchRenderer.setSketch(this.sketch.all);
    this.sketchRenderer.setSelected(this.selected);
    this.sketchRenderer.setLastLabel(this.selected);
    this.holdSources.clear();
    this.held.clear();
    this.mouse.releaseAll();
    this.toasts.show('Scale cancelled');
  }

  private beginExtrusion(): void {
    if (this.stroke) {
      this.toasts.show('Finish drawing before extruding', 'error');
      return;
    }
    const selected = this.selected ?? this.entityAtCursor();
    const target = selected ? this.sketch.getProfile(selected.id) : null;
    if (!target) {
      this.toasts.show('Select a closed planar outline: point inside it and pinch, click, or press S.', 'error', 5000);
      return;
    }
    if (!isExtrudableProfile(target.corners)) {
      this.toasts.show('This outline is not a simple closed planar profile. Draw a new closed outline to extrude.', 'error');
      return;
    }
    if ((target.type === 'triangle' || target.type === 'prism') && !isTriangleProfile(target.corners)) {
      this.toasts.show('This triangle is degenerate. Draw a new closed triangle to extrude.', 'error');
      return;
    }
    this.selectEntity(target);
    const faces = profileFaces(target);
    const faceIndex = defaultFaceIndex(faces, this.viewport.viewDirection());
    this.extrusion = new ExtrusionSession(target, this.orbit.worldPerPixel(), this.gridEnabled ? this.gridStep : 0, faceIndex);
    this.sketchRenderer.setSketch(this.sketch.drawable.filter((entity) => entity.id !== target.id));
    this.sketchRenderer.setSelected(null);
    this.hover = null;
    this.sketchRenderer.setHover(null);
    this.sketchRenderer.setExtrusion(this.extrusion.preview);
    this.sketchRenderer.setActiveFace(this.extrusion.face);
    // Surface the Push/Pull operation UI: reopen a collapsed inspector
    // temporarily and restore it when the session ends.
    if (!this.shell.layout.inspectorVisible) {
      this.inspectorOpenedForExtrusion = true;
      this.shell.setLayout({ inspectorVisible: true, inspectorTab: 'properties' });
    } else if (this.shell.layout.inspectorTab !== 'properties') {
      this.shell.setLayout({ inspectorTab: 'properties' });
    }
    this.updateExtrusion();
    this.hud.flash(`Extruding ${this.extrusion.face.label} face — hover or Tab to switch · drag to pull`);
    this.publishUi();
  }

  private updateExtrusion(): void {
    const session = this.extrusion;
    if (!session || this.voiceCapture) return;
    if (!this.focused || this.measure.isOpen || this.help.visible) {
      session.pause();
      return;
    }
    if (this.navigationMode) {
      session.pause(false);
      return;
    }
    const projector = this.viewport.projector();
    const hand = this.cursor.hand;
    const source = this.cursorSource;
    const gripping = this.held.has('draw') || !!hand?.pinching;
    const before = { preview: session.preview, faceIndex: session.faceIndex };
    if (!session.dragging && !gripping && this.cursor.position && source) {
      const hovered = pickProfileFace(session.currentFaces(), this.cursor.position, projector);
      if (hovered !== null && hovered !== session.faceIndex) session.setFace(hovered);
    }
    // Screen direction that pulls the active face outward: the projected normal.
    const face = session.face;
    const p0 = projector.project(face.center);
    const p1 = projector.project(add(face.center, scale(face.normal, 100 * session.mmPerPixel)));
    let along = v2(0, -1);
    if (p0 && p1) {
      const projected = sub2(p1, p0);
      if (length2(projected) >= 2) along = normalize2(projected);
    }
    session.update(this.cursor.position, gripping, source, along);
    if (!sameSolidPreview(session.preview, before.preview) || session.faceIndex !== before.faceIndex) {
      this.sketchRenderer.setExtrusion(session.preview);
      this.sketchRenderer.setActiveFace(session.face);
    }
  }

  private commitExtrusion(): void {
    const session = this.extrusion;
    if (!session) return;
    if (Math.abs(session.depth) < 1e-6) {
      this.toasts.show('Set a non-zero depth: pinch and move up/down, or press L to type one.', 'error');
      return;
    }
    const preview = session.preview;
    if (preview.type === 'extrusion' && !isExtrudableProfile(preview.corners)) {
      this.toasts.show('The preview is degenerate — pull the face back out or press Esc.', 'error');
      return;
    }
    if (preview.type === 'prism' && (!isTriangleProfile(preview.corners) || !entityPoints(preview).every(isFinite3))) {
      this.toasts.show('The preview is degenerate — pull the face back out or press Esc.', 'error');
      return;
    }
    // Clear the preview transaction before the command emits its model change.
    this.extrusion = null;
    const result = this.commands.extrude(session.profile.id, session.depth, preview.corners);
    this.sketchRenderer.setExtrusion(null);
    this.sketchRenderer.setActiveFace(null);
    this.sketchRenderer.setSketch(this.sketch.drawable);
    this.holdSources.clear();
    this.held.clear();
    this.mouse.releaseAll();
    if (result.ok) {
      this.lastCommitted = result.entity;
      this.selectEntity(result.entity);
      this.sketchRenderer.setLastLabel(result.entity);
    }
    if (result.ok) this.hud.flash(result.message, 'success');
    else this.toasts.show(result.error, 'error');
    this.endExtrusionUi();
  }

  private cancelExtrusion(): void {
    this.voiceCapture = null;
    this.voice.cancel();
    this.extrusion = null;
    this.sketchRenderer.setExtrusion(null);
    this.sketchRenderer.setActiveFace(null);
    this.sketchRenderer.setSketch(this.sketch.drawable);
    this.sketchRenderer.setSelected(this.selected);
    this.sketchRenderer.setLastLabel(this.selected);
    this.holdSources.clear();
    this.held.clear();
    this.mouse.releaseAll();
    this.hud.flash('Extrusion cancelled');
    this.endExtrusionUi();
  }

  /** Restore an inspector that was auto-opened for Push/Pull, and republish. */
  private endExtrusionUi(): void {
    if (this.inspectorOpenedForExtrusion) {
      this.inspectorOpenedForExtrusion = false;
      this.shell.setLayout({ inspectorVisible: false });
    }
    this.publishUi();
  }

  private async exportToFreeCad(): Promise<void> {
    if (!this.sketch.size) {
      this.toasts.show('Nothing to export yet', 'error');
      return;
    }
    try {
      let preview: Entity | null = this.scaling?.preview ?? this.movement?.preview ?? this.extrusion?.preview ?? null;
      if (preview?.type === 'extrusion' && Math.abs(preview.depth) < 1e-6) {
        preview = isRectangleProfile(preview.corners)
          ? { id: preview.id, type: 'rect', corners: preview.corners as [Vec3, Vec3, Vec3, Vec3] }
          : { id: preview.id, type: 'polygon', corners: preview.corners };
      } else if (preview?.type === 'prism' && Math.abs(preview.depth) < 1e-6) {
        preview = { id: preview.id, type: 'triangle', corners: preview.corners };
      }
      const entities = this.sketch.all.map((entity) => preview && entity.id === preview.id ? preview : entity);
      const payload = this.commands.exportPayload(entities);
      this.toasts.show(`Exporting ${payload.entities.length} entities to FreeCAD...`);
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
    if (entity.type === 'line') return entity.b;
    if (entity.type === 'circle') return entity.center;
    return entity.corners[0];
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
      this.hud.flash(`Plane ${choice.plane.label} from stroke direction`);
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
        if (!result.ok) return { ok: false, error: result.error };
        this.lastCommitted = result.entity;
        this.sketchRenderer.setLastLabel(result.entity);
        this.plane = this.plane.withAnchor(anchorAfterCommit(result.entity));
        this.hud.flash(result.message, 'success');
        return { ok: true };
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
    this.hud.flash(kind === 'origin' ? 'Hold the tracked tip still to set the origin…' : 'Hold still to recenter…');
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
      this.hud.flash('Origin set', 'success');
      if (!this.sketch.size && !this.fittedWorkspace) {
        this.orbit.setView('iso', false, this.nowMs);
        this.fitWorkspace();
        this.fittedWorkspace = true;
      }
    } else {
      const world = this.lastCommitted ? anchorAfterCommit(this.lastCommitted) : { x: 0, y: 0, z: 0 };
      this.spatial.mapping.recenter(median, world);
      this.hud.flash('Recentered on the last endpoint', 'success');
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
    if (this.applyingTracker) {
      this.hud.flash('Still applying the previous change…');
      return;
    }
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
      // Re-render the last acknowledged config so the selects snap back.
      this.toasts.show(result.error, 'error');
      this.refreshPanel();
      return;
    }
    this.tracker.lastSnapshot = result.snapshot;
    this.trackerConfig = result.snapshot.config;
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
    const now = this.nowMs || performance.now();
    this.pip.setSource(this.trackerConfig.source);
    this.panel.update({
      source: this.trackerConfig.source,
      target: this.trackerConfig.target,
      colorPreset: this.trackerConfig.colorPreset,
      colorTolerance: this.trackerConfig.colorTolerance,
      scale: this.spatial.mapping.scale,
      calibrated: this.spatial.mapping.calibrated,
      depthaiInstalled: this.tracker?.lastSnapshot?.capabilities.depthaiInstalled ?? false,
      connection: this.connection,
      camera: this.cameraState,
      cameraMessage: this.tracker?.lastStatus?.message ?? null,
      tracking: this.cursor.tracking,
      spatialState: this.isDepthSource() ? this.spatial.hudState(now) : null,
      spatialReason: this.spatial.reason,
      collecting: this.spatial.calibration.phase === 'collecting',
      calibrationSamples: this.spatial.calibration.samples.length,
      calibrationGoal: CALIBRATION_MIN_SAMPLES,
      streamId: this.tracker?.lastSnapshot?.streamId ?? this.spatial.streamId,
      trackingAgeMs: this.spatial.last?.ageMs ?? null,
      navAssist: this.navAssist,
      pipVisible: this.pip.visible,
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

  // ---------------------------------------------------------------- strokes

  private computeSnap(cursorPx: Vec2): SnapResult {
    const plane = this.stroke ? this.stroke.plane : this.plane;
    const scaling = this.scaling;
    const projector = this.viewport.projector();
    if (scaling?.handle) {
      const { anchor, point } = scaling.handle;
      const world = add(anchor, scale(sub(point, anchor), scaling.factor));
      const screen = projector.project(world);
      if (screen) return { type: 'lock', world, plane: plane.toPlane(world), screen, onPlane: plane.contains(world, 1e-6), raw: null, entityId: scaling.entity.id };
    }
    return snapCursor({
      cursor: cursorPx,
      projector,
      plane,
      targets: scaling
        ? { vertices: entityScaleHandles(scaling.preview).map(({ point }, index) => ({ point, index, entityId: scaling.entity.id })), midpoints: [], segments: [] }
        : { vertices: this.sketch.vertices(), midpoints: this.sketch.midpoints(), segments: this.sketch.segments() },
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
    if (this.stroke || this.extrusion || this.movement || this.scaling || this.navMode || !this.cursor.position) return;
    if (this.help.visible || this.measure.isOpen || this.cursor.isLost) return;
    this.orbit.cancelTransition(true);
    const position = this.cursor.position;
    const snap = this.computeSnap(position);
    this.planeBeforeStroke = this.plane;
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
    if (anchorMoved) this.hud.flash(`Plane ${plane.label} moved through the snapped point`);
  }

  /**
   * React to a cursor update (hand frame or mouse move) immediately, so pen
   * deltas and stroke sampling do not depend on the render frame rate.
   */
  private onCursorMoved(): void {
    const position = this.cursor.position;
    if (this.voiceCapture) {
      this.previousCursor = null;
      return;
    }
    if (!position) return;
    this.focused = true;
    if (this.cursor.isLost || this.help.visible || this.measure.isOpen) {
      this.previousCursor = null;
      this.extrusion?.pause();
      this.pauseMove();
      this.pauseScale();
      return;
    }
    this.synchronizeNavigation(false);
    const mode = this.mode;
    if (mode === 'ORBIT' || mode === 'PAN') {
      this.extrusion?.pause(false);
      this.pauseMove(false);
      this.pauseScale(false);
      this.applyNavigationDelta(position);
      return;
    }
    this.previousCursor = null;
    if (this.scaling) this.updateScale();
    else if (this.movement) this.updateMove();
    else if (this.extrusion) this.updateExtrusion();
    else this.sampleStroke();
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
      if (dx !== 0 || dy !== 0) {
        if (mode === 'ORBIT') this.orbit.orbit(dx, dy, this.sketch.center());
        else this.orbit.pan(dx, dy);
      }
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
    if (!stroke || !position || this.cursor.isLost || this.navigationMode || this.voiceCapture) return;
    const snap = this.computeSnap(position);
    stroke.add(snap, snap.raw, position, 2);
  }

  private resolveFor(stroke: StrokeSession): GuidedStrokeResolution {
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
    const base = this.isDepthSource()
      ? this.resolveSpatial(stroke)
      : resolveStroke(stroke, {
          projector: this.viewport.projector(),
          vertices: this.sketch.vertices(),
          tolerancePx: SNAP_TOLERANCE_PX,
          gridStep: this.gridEnabled ? this.strokeGridStep : 0,
          entities: this.sketch.all,
        });
    const resolution = inferStrokeEdges(stroke, base, {
      projector: this.viewport.projector(),
      entities: this.sketch.all,
      tolerancePx: SNAP_TOLERANCE_PX,
      gridStep: (this.isDepthSource() ? this.depthGridEnabled : this.gridEnabled) ? this.strokeGridStep : 0,
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
    this.sketchRenderer.setEdgeGuide(null);
    this.sketchRenderer.setInk(null);
    this.sketchRenderer.setLineGuide(null, null);
    const minExtent = this.isDepthSource() ? 5 * this.spatial.mapping.scale : MIN_STROKE_PX;
    const extent = this.isDepthSource() ? stroke.worldExtent() : stroke.screenExtent();
    if (extent < minExtent) {
      this.resolutionCache = null;
      if (this.planeBeforeStroke) this.plane = this.planeBeforeStroke;
      this.planeBeforeStroke = null;
      this.selectAtCursor();
      return;
    }
    this.planeBeforeStroke = null;

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
        this.toasts.show('Not recognized: draw a straight line or a closed outline', 'error');
      } else {
        this.hud.flash(resolution.reason);
      }
      return;
    }
    const commit = this.commands.commitStroke(resolution.input, resolution.removeIds);
    if (!commit.ok) {
      this.toasts.show(commit.error, 'error');
      return;
    }
    this.lastCommitted = commit.entity;
    this.selectEntity(commit.entity);
    this.sketchRenderer.setLastLabel(commit.entity);
    this.plane = stroke.plane.withAnchor(anchorAfterCommit(resolution.input));
    this.hud.flash(commit.message, 'success');
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
    this.voiceCapture = null;
    this.voice.cancel();
    this.stroke = null;
    this.depthBuffer = null;
    this.resolutionCache = null;
    if (this.planeBeforeStroke) this.plane = this.planeBeforeStroke;
    this.planeBeforeStroke = null;
    this.sketchRenderer.setGhost(null, false, null);
    this.sketchRenderer.setEdgeGuide(null);
    this.sketchRenderer.setInk(null);
    this.sketchRenderer.setLineGuide(null, null);
    this.hud.flash('Stroke cancelled');
    this.synchronizeNavigation(false);
  }

  private cancelInteraction(): void {
    if (this.stroke) this.cancelStroke();
    this.extrusion?.pause();
    this.pauseMove();
    this.pauseScale();
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

  private updateLineGuide(stroke: StrokeSession, measurement: LineMeasurement | null, locked = false): void {
    if (!measurement) {
      this.sketchRenderer.setLineGuide(null, null);
      return;
    }
    const a = measurement.start;
    const b = add(a, scale(measurement.direction, measurement.previewLength + this.orbit.worldPerPixel() * 160));
    const degrees = Math.atan2(dot(measurement.direction, stroke.plane.v), dot(measurement.direction, stroke.plane.u)) * 180 / Math.PI;
    this.sketchRenderer.setLineGuide([a, b], {
      text: `${locked ? 'Voice direction locked' : 'Voice aim'} · ${degrees.toFixed(1)}°${locked ? '' : ' · V to lock'}`,
      at: b,
    });
  }

  private applyGhost(resolution: GuidedStrokeResolution): void {
    this.sketchRenderer.setEdgeGuide(resolution.guide);
    if (resolution.status !== 'ready') {
      this.sketchRenderer.setGhost(null, false, null);
      return;
    }
    const input = resolution.input;
    if (input.type === 'polygon' || input.type === 'triangle') {
      const fake: Entity = { ...input, id: 'ghost' };
      this.sketchRenderer.setGhost(entityPoints(fake), true, {
        text: entityLabel(fake),
        at: entityCenter(fake),
      });
      return;
    }
    if (input.type !== 'line' && input.type !== 'rect') {
      this.sketchRenderer.setGhost(null, false, null);
      return;
    }
    const fake: Entity = { ...input, id: 'ghost' };
    const shared = resolution.reason === 'shared-border rectangle' || resolution.reason === 'assembled rectangle';
    this.sketchRenderer.setGhost(entityPoints(fake), fake.type !== 'line', {
      text: `${entityLabel(fake)}${shared ? ' · shared border' : ''}`,
      at: entityCenter(fake),
    });
  }

  private updateGhost(stroke: StrokeSession): void {
    const captured = this.voiceCapture?.target;
    if (captured && captured.source === stroke && captured.operation.kind === 'line') {
      const measurement = captured.operation.measurement;
      this.updateLineGuide(stroke, measurement, true);
      const a = measurement.start;
      const b = add(a, scale(measurement.direction, measurement.previewLength));
      this.sketchRenderer.setInk(stroke.worldPath());
      this.sketchRenderer.setGhost([a, b], false, { text: formatMm(measurement.previewLength), at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 } });
      return;
    }
    if (this.depthBuffer?.state === 'pending') {
      this.sketchRenderer.setInk(this.depthBuffer.polyline(this.spatial.world ?? undefined));
      this.sketchRenderer.setGhost(null, false, null);
      this.sketchRenderer.setLineGuide(null, null);
      this.sketchRenderer.setEdgeGuide(null);
      return;
    }
    this.sketchRenderer.setInk(stroke.worldPath());
    const resolution = this.resolveFor(stroke);
    const showAim = !resolution.input || resolution.input.type === 'line';
    this.updateLineGuide(stroke, showAim ? stroke.measurement : null);
    this.applyGhost(resolution);
  }

  // ---------------------------------------------------------------- frame loop

  private frame(time: number): void {
    requestAnimationFrame((next) => this.frame(next));
    this.nowMs = time;
    this.orbit.update(time);
    if (this.cursor.tracking === 'hand' && performance.now() / 1000 - this.lastHandMessageAt > 0.6) {
      this.cursor.dropHand();
      this.extrusion?.pause();
      this.pauseMove();
      this.pauseScale();
      this.previousCursor = null;
    }
    const cursorPx = this.voiceCapture ? this.voiceCapture.cursor : this.cursor.position;
    const projector = this.viewport.projector();
    const viewDirection = this.viewport.viewDirection();
    const mode = this.mode;

    this.updatePlaneInference(time);

    const cursorRay = cursorPx ? projector.ray(cursorPx) : null;
    const cursorHit = cursorRay ? this.plane.intersectRay(cursorRay.origin, cursorRay.dir) : null;
    const reference: Vec3 = this.stroke ? this.stroke.start.world : cursorHit ?? this.plane.anchor;
    this.gridStep = this.stroke ? this.strokeGridStep : adaptiveGridStep(projector, this.plane, reference, GRID_MIN_PX);

    const snap: SnapResult | null = this.voiceCapture ? this.voiceCapture.snap : cursorPx ? this.computeSnap(cursorPx) : null;
    this.lastSnap = snap;

    if (this.stroke) {
      this.updateGhost(this.stroke);
    } else if (this.isDepthSource() && this.spatial.world && mode === 'READY') {
      this.updateSpatialHover(this.spatial.world);
    } else {
      const hovered = snap && cursorPx && mode === 'READY' && !this.cursor.isLost ? this.hoveredEntity(snap) ?? pickFace(this.sketch.drawable, cursorPx, projector) : null;
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
      cameraMessage: this.tracker?.lastStatus?.message ?? null,
      inputSource: this.trackerConfig.source,
      spatialState: this.isDepthSource() ? this.spatial.hudState(this.nowMs || performance.now()) : null,
      spatialReason: this.spatial.reason,
      collecting: this.spatial.calibration.phase === 'collecting',
      calibrationSamples: this.spatial.calibration.samples.length,
      calibrationGoal: CALIBRATION_MIN_SAMPLES,
      projection: this.viewport.ortho ? 'Ortho' : 'Persp',
      navAssist: this.navAssist,
      edgeOn: displayedPlane.isEdgeOn(viewDirection),
      entityCount: this.sketch.size,
      selected: this.scaling ? describeEntity(this.scaling.preview) : this.selected ? describeEntity(this.selected) : null,
      extrusion: this.extrusion ? { depth: this.extrusion.depth, dragging: this.extrusion.dragging, face: this.extrusion.face.label, pulled: this.extrusion.pulled } : null,
      dialogOpen: this.measure.isOpen || this.help.visible,
      voice: this.voiceCapture?.target.description ?? null,
    });
    this.hud.setKeys(this.keyHints(mode));
    this.publishUiIfChanged();

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
      if (shared) return this.resolveSelection(last);
    }
    return this.resolveSelection(this.sketch.get(snap.entityId) ?? null);
  }

  private keyHints(mode: Mode): KeyHint[] {
    const key = (action: PressAction | HoldAction) => labelForAction(action, this.platform);
    if (this.measure.isOpen) return [{ key: 'Enter', label: 'apply' }, { key: 'Esc', label: 'cancel' }];
    if (this.voiceCapture) {
      return [
        { key: key('voice'), label: 'confirm / retry' },
        { key: key('cancel'), label: 'cancel draft' },
      ];
    }
    switch (mode) {
      case 'EXTRUDING':
        return [
          { key: this.cursor.hand ? 'Pinch' : 'Drag / Space', label: 'pull face' },
          { key: 'Enter / Q', label: 'apply' },
          { key: key('voice'), label: 'voice distance' },
          { key: key('cancel'), label: 'cancel' },
        ];
      case 'MOVING':
        return [
          { key: this.cursor.hand ? 'Pinch' : 'Drag / Space', label: 'move shape' },
          { key: key('cyclePlane'), label: 'move plane' },
          { key: key('toggleGrid'), label: 'grid snap' },
          { key: key('orbit'), label: 'orbit' },
          { key: key('pan'), label: 'pan' },
          { key: 'Enter / M', label: 'apply' },
          { key: key('cancel'), label: 'cancel' },
        ];
      case 'SCALING':
        return [
          { key: this.cursor.hand ? 'Pinch' : 'Drag / Space', label: this.scaling?.handle ? 'scale shape' : 'lock corner & scale' },
          { key: key('toggleGrid'), label: 'grid snap' },
          { key: key('orbit'), label: 'orbit' },
          { key: key('pan'), label: 'pan' },
          { key: 'Enter / R', label: 'apply' },
          { key: key('cancel'), label: 'cancel' },
        ];
      case 'DRAWING':
        return [
          { key: key('draw'), label: 'release to commit' },
          { key: 'X / Y / Z', label: 'hold to lock axis' },
          { key: key('voice'), label: 'lock aim / voice' },
          { key: key('cancel'), label: 'cancel stroke' },
        ];
      case 'ORBIT':
        return [{ key: key('orbit'), label: 'move to orbit · release to stop' }];
      case 'PAN':
        return [{ key: key('pan'), label: 'move to pan · release to stop' }];
      default: {
        // At most four chips: anything more overflows the status bar.
        const target = this.selected ?? this.hover;
        return [
          { key: key('draw'), label: 'draw' },
          { key: key('orbit'), label: 'orbit' },
          target ? { key: key('measure'), label: 'size' } : { key: key('select'), label: 'select' },
          { key: key('help'), label: 'help' },
        ];
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
        this.focused = true;
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
      selected: () => this.selected,
      extrusion: () => this.extrusion ? {
        depth: this.extrusion.depth,
        dragging: this.extrusion.dragging,
        face: this.extrusion.face.label,
        preview: this.extrusion.preview,
        ...(this.extrusion.preview.type === 'extrusion' || this.extrusion.preview.type === 'prism' ? { corners: this.extrusion.preview.corners } : {}),
      } : null,
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
  selected(): Entity | null;
  extrusion(): { depth: number; dragging: boolean; face: string; preview: SolidEntity; corners?: ExtrusionEntity['corners'] | TriangleEntity['corners'] } | null;
}

declare global {
  interface Window {
    aircad?: AirCadApi;
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');
window.aircad = new App(root).api;
