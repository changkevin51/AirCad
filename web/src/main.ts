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
import { defaultTrackerUrl, TrackerClient, type CameraState, type ConnectionState, type HandsMessage, type NavMessage } from './input/tracker-client';
import { Commands } from './model/commands';
import { nextPlaneKind, WorkPlane, type Axis, type PlaneKind } from './model/plane';
import { PlaneInference, type PlaneMode } from './model/plane-inference';
import { adaptiveGridStep, snapCursor, type SnapResult } from './model/snap';
import { describeEntity, entityCenter, entityMidpoints, entityPoints, entityVertices, Sketch, type Entity } from './model/sketch';
import { anchorAfterCommit, resolveStroke, StrokeSession, type StrokeResolution } from './model/stroke';
import { dot, nearlyEqual, type Vec2, type Vec3 } from './model/vec';
import { entityLabel, SketchRenderer } from './render/sketch-renderer';
import { AxisTriad, createGroundGrid } from './scene/grid';
import { OrbitController, type ViewPreset } from './scene/orbit';
import { Viewport } from './scene/viewport';
import { WorkPlaneVisual } from './scene/workplane-visual';
import { CursorGlyph } from './ui/cursor-glyph';
import { HelpOverlay } from './ui/help';
import { Hud, type KeyHint, type Mode } from './ui/hud';
import { MeasureInput } from './ui/measure-input';
import { CameraPip } from './ui/pip';
import { Toasts } from './ui/toast';

const SNAP_TOLERANCE_PX = 14;
const MIN_STROKE_PX = 6;
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
  private gridStep = 100;
  private navAssist = false;
  private connection: ConnectionState = 'closed';
  private cameraState: CameraState | null = null;
  private reportedCameraError = false;
  private lastRecognition: { reason: string; points: Vec2[]; screenExtent: number } | null = null;
  private nowMs = 0;

  constructor(root: HTMLElement) {
    const viewportElement = document.createElement('div');
    viewportElement.className = 'viewport';
    viewportElement.tabIndex = 0;
    root.appendChild(viewportElement);

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
    this.sketchRenderer = new SketchRenderer(this.viewport);
    this.orbit.fit(null);

    this.hud = new Hud(root);
    this.glyph = new CursorGlyph(root);
    this.toasts = new Toasts(root);
    this.pip = new CameraPip(root);
    this.measure = new MeasureInput(root);
    this.help = new HelpOverlay(root, this.platform);

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
      onStatus: (message) => {
        this.cameraState = message.camera;
        this.pip.setCameraState(this.cameraState, this.connection === 'open');
        if (message.camera === 'error' && !this.reportedCameraError) {
          this.reportedCameraError = true;
          this.toasts.show(`Camera unavailable: ${message.message}. Using the mouse.`, 'error', 6000);
        }
      },
      onConnection: (state) => {
        this.connection = state;
        if (state !== 'open') {
          this.cursor.dropHand();
          this.endPalmNav(false);
          this.synchronizeNavigation(false);
        }
        this.pip.setCameraState(this.cameraState, state === 'open');
      },
    });
    this.tracker.connect();

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.onKeyUp(event));
    window.addEventListener('blur', () => this.cancelInteraction());
    viewportElement.focus();

    this.toasts.show('Hold Space to draw, Shift to orbit, Ctrl to pan. H for help.', 'info', 5000);
    requestAnimationFrame((time) => this.frame(time));
  }

  // ---------------------------------------------------------------- input

  private isTypingTarget(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
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
    if (is && !was) this.beginHold(action);
    else if (!is && was) this.endHold(action);
    if (was !== is && this.stroke && (action === 'lockX' || action === 'lockY' || action === 'lockZ')) this.sampleStroke();
  }

  private beginHold(action: HoldAction): void {
    if (action === 'draw') {
      this.endPalmNav(false);
      this.synchronizeNavigation(false);
      this.beginStroke();
      return;
    }
    this.synchronizeNavigation(false);
  }

  private endHold(action: HoldAction): void {
    if (action === 'draw') {
      this.endStroke();
      this.synchronizeNavigation(false);
      return;
    }
    this.synchronizeNavigation(action === 'orbit');
  }

  private synchronizeNavigation(allowSettle = false): void {
    const blocked =
      !!this.stroke || this.held.has('draw') || this.help.visible || this.measure.isOpen || this.cursor.isLost;
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
    if (this.stroke) return 'DRAWING';
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
      !this.stroke &&
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
    if (this.stroke && BLOCKED_WHILE_DRAWING.has(action)) return;
    if (this.stroke && CANCEL_STROKE_FIRST.has(action)) this.cancelStroke();
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
        this.orbit.fit(this.sketch.boundingBox());
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
        this.gridEnabled = !this.gridEnabled;
        this.sampleStroke();
        this.toasts.show(`Grid snap ${this.gridEnabled ? 'on' : 'off'}`);
        break;
      case 'toggleNavAssist':
        this.navAssist = !this.navAssist;
        if (!this.navAssist) this.endPalmNav(false);
        this.toasts.show(`Palm navigation ${this.navAssist ? 'on: one open palm orbits, two palms pan/zoom' : 'off'}`);
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
        if (this.stroke) this.cancelStroke();
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
    if (this.stroke) return;
    this.plane = this.plane.withKind(kind);
    if (announce) this.toasts.show(`Work plane ${this.plane.label}`);
  }

  private zoomAtCursor(factor: number, point?: Vec2): void {
    if (factor === 1 || !Number.isFinite(factor)) return;
    if (this.stroke || this.help.visible || this.measure.isOpen) return;
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
      this.palmNavMode
    ) {
      return;
    }
    const snap = this.computeSnap(this.cursor.position);
    const choice = this.inference.update(this.inferenceContext(this.cursor.position, snap), nowMs);
    this.plane = choice.plane;
    this.planeReason = choice.reason;
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
      this.plane = plane;
      this.planeReason = choice.reason;
    }
    let anchorMoved = false;
    if (snap.type === 'vertex' || snap.type === 'midpoint' || snap.type === 'edge') {
      // The work plane always passes through the anchor; starting on a vertex,
      // midpoint or edge moves it there so a wall drawn from a floor edge
      // stands on the floor.
      anchorMoved = !plane.contains(snap.world, 1e-6);
      plane = plane.withAnchor(snap.world);
      this.plane = plane;
    }
    const projector = this.viewport.projector();
    const ray = projector.ray(position);
    const objectStart = snap.type === 'vertex' || snap.type === 'midpoint' || snap.type === 'edge';
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
      if (this.previousCursor) {
        const dx = position.x - this.previousCursor.x;
        const dy = position.y - this.previousCursor.y;
        if (mode === 'ORBIT') this.orbit.orbit(dx, dy, this.sketch.center());
        else this.orbit.pan(dx, dy);
      }
      this.previousCursor = { ...position };
      return;
    }
    this.sampleStroke();
  }

  /** Capture the current cursor into the active stroke; tracking loss pauses capture. */
  private sampleStroke(): void {
    const stroke = this.stroke;
    const position = this.cursor.position;
    if (!stroke || !position || this.cursor.isLost) return;
    const snap = this.computeSnap(position);
    stroke.add(snap, snap.raw, position);
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
    if (stroke.screenExtent() < MIN_STROKE_PX) {
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
    if (this.stroke) this.cancelStroke();
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

  private updateGhost(stroke: StrokeSession): void {
    this.sketchRenderer.setInk(stroke.worldPath());
    const resolution = this.resolveFor(stroke);
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
      // Points are captured in onCursorMoved; the ghost follows the camera too.
      this.updateGhost(this.stroke);
    } else {
      const hovered = snap && mode === 'READY' ? this.hoveredEntity(snap) : null;
      if (hovered !== this.hover) {
        this.hover = hovered;
        this.sketchRenderer.setHover(hovered);
      }
    }

    const focus = snap?.onPlane ? snap.plane : this.plane.toPlane(this.plane.anchor);
    this.planeVisual.update(this.stroke ? this.stroke.plane : this.plane, this.gridStep, focus);
    this.glyph.update(snap, cursorPx, !!this.stroke);
    this.sketchRenderer.tick(time);

    const displayedPlane = this.stroke ? this.stroke.plane : this.plane;
    this.hud.update({
      mode,
      plane: displayedPlane.info,
      planeMode: this.stroke ? 'Locked' : this.planeMode === 'auto' ? 'Auto' : 'Manual',
      planeReason: this.stroke ? 'locked' : REASON_LABELS[this.planeReason] ?? null,
      snap: snap?.type ?? null,
      snapAxis: snap?.axis ?? null,
      gridStep: this.gridStep,
      gridEnabled: this.gridEnabled,
      tracking: this.cursor.tracking,
      connection: this.connection,
      camera: this.cameraState,
      projection: this.viewport.ortho ? 'Ortho' : 'Persp',
      navAssist: this.navAssist,
      edgeOn: this.plane.isEdgeOn(viewDirection),
      entityCount: this.sketch.size,
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
}

declare global {
  interface Window {
    aircad?: AirCadApi;
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');
window.aircad = new App(root).api;
