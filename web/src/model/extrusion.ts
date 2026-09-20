import { profileFaces, pushPull, sameProfileFace, type ProfileFace } from './faces';
import {
  isExtrudableProfile,
  isRectangleProfile,
  type ExtrusionEntity,
  type PrismEntity,
  type ProfileEntity,
  type RectEntity,
  type TriangleEntity,
  type TriangleProfileEntity,
} from './sketch';
import { clone, dot2, nearlyEqual, roundTo, sub2, type Vec2, type Vec3 } from './vec';

export interface FacePullMeasurement {
  base: ProfileEntity;
  axis: ProfileFace['axis'];
  sign: ProfileFace['sign'];
  edgeIndex?: number;
  direction: 1 | -1;
}

type PreviewFor<P extends ProfileEntity> = P extends TriangleProfileEntity ? PrismEntity : ExtrusionEntity;
type CornersFor<P extends ProfileEntity> = P extends TriangleProfileEntity ? TriangleEntity['corners'] : Vec3[];

/** A preview transaction: no model/history writes until the user confirms. */
export class ExtrusionSession<P extends ProfileEntity = ProfileEntity> {
  /** Faces of the original profile, refreshed to track the preview geometry. */
  readonly faces: ProfileFace[];
  faceIndex: number;
  corners: CornersFor<P>;
  /** Signed depth along the extrusion normal of the original profile. */
  depth: number;
  error: string | null = null;
  /** Geometry the active face's pull started from; re-snapshotted by setFace. */
  private base: ProfileEntity;
  private pull = 0;
  private grab: { position: Vec2; pull: number; base: ProfileEntity; axis: ProfileFace['axis']; sign: ProfileFace['sign']; edgeIndex?: number } | null = null;
  private measurementState: FacePullMeasurement | null = null;
  private source: string | null = null;
  private needsRelease = false;

  constructor(
    readonly profile: P,
    readonly mmPerPixel: number,
    readonly step: number,
    faceIndex: number,
  ) {
    this.faces = profileFaces(profile);
    this.faceIndex = Math.min(Math.max(0, faceIndex), this.faces.length - 1);
    this.base = profile;
    this.depth = profile.type === 'extrusion' || profile.type === 'prism' ? profile.depth : 0;
    this.corners = profile.corners.map(clone) as CornersFor<P>;
  }

  private get minSize(): number {
    return this.step > 0 ? this.step : 1;
  }

  get face(): ProfileFace {
    return this.currentFaces()[this.faceIndex] ?? this.faces[this.faceIndex];
  }

  get dragging(): boolean { return this.grab !== null; }

  get changed(): boolean {
    const profile = this.profile;
    const depth = profile.type === 'extrusion' || profile.type === 'prism' ? profile.depth : 0;
    if (this.depth !== depth) return true;
    return !this.corners.every((corner, index) => nearlyEqual(corner, profile.corners[index], 1e-6));
  }

  get preview(): PreviewFor<P> {
    if (this.profile.type === 'triangle' || this.profile.type === 'prism') {
      return { id: this.profile.id, type: 'prism', corners: this.corners, depth: this.depth } as PreviewFor<P>;
    }
    return { id: this.profile.id, type: 'extrusion', corners: this.corners, depth: this.depth } as PreviewFor<P>;
  }

  /** Total outward distance the active face has been pulled so far (mm). */
  get pulled(): number { return this.pull; }

  get measurement(): FacePullMeasurement | null {
    return this.measurementState ? structuredClone(this.measurementState) : null;
  }

  /** Faces of the current preview; the active face's quad lives here. */
  currentFaces(): ProfileFace[] {
    return profileFaces(this.preview);
  }

  /** Keep this.faces' quads/centers glued to the preview by (axis, sign, edgeIndex). */
  private refreshFaces(): void {
    const active = this.faces[this.faceIndex];
    const current = this.currentFaces();
    this.faces.splice(0, this.faces.length, ...current);
    const index = active ? current.findIndex((face) => sameProfileFace(face, active)) : -1;
    this.faceIndex = index >= 0 ? index : Math.min(this.faceIndex, this.faces.length - 1);
  }

  private flatBase(): ProfileEntity {
    const corners = structuredClone(this.corners);
    if (this.profile.type === 'triangle' || this.profile.type === 'prism') {
      return { id: this.profile.id, type: 'triangle', corners: corners as TriangleEntity['corners'] };
    }
    if (corners.length === 4 && isRectangleProfile(corners)) {
      return { id: this.profile.id, type: 'rect', corners: corners as RectEntity['corners'] };
    }
    return { id: this.profile.id, type: 'polygon', corners };
  }

  private applyPull(pull: number, minSize = this.minSize): boolean {
    try {
      const result = pushPull(this.base, this.face, pull, minSize);
      if (!Number.isFinite(result.depth) || !isExtrudableProfile(result.corners)) {
        throw new Error('That pull would create invalid geometry');
      }
      this.pull = pull;
      this.corners = result.corners as CornersFor<P>;
      this.depth = result.depth;
      this.error = null;
      this.refreshFaces();
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'That pull cannot be represented';
      return false;
    }
  }

  /** Switch face; only allowed when not dragging. Snapshots current geometry as the new base. */
  setFace(index: number): boolean {
    if (this.dragging || index < 0 || index >= this.faces.length) return false;
    if (index === this.faceIndex) return true;
    this.faceIndex = index;
    this.base = Math.abs(this.depth) < 1e-9 ? this.flatBase() : this.preview;
    this.pull = 0;
    this.measurementState = null;
    this.refreshFaces();
    return true;
  }

  cycleFace(): boolean {
    return this.setFace((this.faceIndex + 1) % this.faces.length);
  }

  /**
   * `along` is the unit screen-space direction (pixels, +y down) in which
   * cursor motion pulls the face outward; release lets the user re-grab.
   */
  update(position: Vec2 | null, gripping: boolean, source: string | null, along: Vec2): void {
    if (!position || !source) {
      this.pause();
      return;
    }
    if (this.source !== null && this.source !== source) this.pause();
    this.source = source;
    if (!gripping) {
      this.grab = null;
      this.needsRelease = false;
      return;
    }
    if (this.needsRelease) return;
    if (!this.grab) {
      const base: ProfileEntity = Math.abs(this.depth) < 1e-9 ? this.flatBase() : structuredClone(this.preview);
      const face = this.face;
      this.grab = { position: { ...position }, pull: this.pull, base, axis: face.axis, sign: face.sign, edgeIndex: face.edgeIndex };
      this.measurementState = null;
      return;
    }
    // Round the delta, so starting a drag never changes an existing exact depth.
    const pixels = dot2(sub2(position, this.grab.position), along);
    const delta = pixels * this.mmPerPixel;
    if (!this.measurementState && Math.abs(pixels) >= 12 && Number.isFinite(delta) && delta !== 0) {
      this.measurementState = {
        base: structuredClone(this.grab.base), axis: this.grab.axis, sign: this.grab.sign, edgeIndex: this.grab.edgeIndex,
        direction: delta > 0 ? 1 : -1,
      };
    }
    this.applyPull(this.grab.pull + roundTo(delta, this.step));
  }

  /** Tracking loss, focus loss, and overlays freeze the preview until a fresh grip. */
  pause(requireRelease = true): void {
    this.grab = null;
    this.needsRelease ||= requireRelease;
  }

  /** Set the active face's total pull to an exact value (mm) relative to the base snapshot. */
  setPull(distance: number): boolean {
    if (!Number.isFinite(distance)) return false;
    this.measurementState = null;
    const ok = this.applyPull(distance, 0);
    this.pause();
    return ok;
  }

  /** Set the signed depth directly; the current geometry becomes the new base. */
  setDepth(depth: number): void {
    if (!Number.isFinite(depth)) return;
    this.depth = depth;
    this.base = Math.abs(this.depth) < 1e-9 ? this.flatBase() : this.preview;
    this.pull = 0;
    this.measurementState = null;
    this.refreshFaces();
    this.pause();
  }
}
