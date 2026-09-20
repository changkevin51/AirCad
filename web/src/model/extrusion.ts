import { profileFaces, pushPull, type ProfileFace } from './faces';
import type { ExtrusionEntity, ProfileEntity } from './sketch';
import { clone, dot2, roundTo, sub2, type Vec2 } from './vec';

export interface FacePullMeasurement {
  base: ProfileEntity;
  axis: ProfileFace['axis'];
  sign: ProfileFace['sign'];
  direction: 1 | -1;
}

/** A preview transaction: no model/history writes until the user confirms. */
export class ExtrusionSession {
  /** Faces of the original profile, refreshed to track the preview geometry. */
  readonly faces: ProfileFace[];
  faceIndex: number;
  corners: ExtrusionEntity['corners'];
  /** Signed depth along the extrusion normal of the original profile. */
  depth: number;
  /** Geometry the active face's pull started from; re-snapshotted by setFace. */
  private base: ProfileEntity;
  private pull = 0;
  private grab: { position: Vec2; pull: number; base: ProfileEntity; axis: ProfileFace['axis']; sign: ProfileFace['sign'] } | null = null;
  private measurementState: FacePullMeasurement | null = null;
  private source: string | null = null;
  private needsRelease = false;

  constructor(
    readonly profile: ProfileEntity,
    readonly mmPerPixel: number,
    readonly step: number,
    faceIndex: number,
  ) {
    this.faces = profileFaces(profile);
    this.faceIndex = Math.min(Math.max(0, faceIndex), this.faces.length - 1);
    this.base = profile;
    this.depth = profile.type === 'extrusion' ? profile.depth : 0;
    this.corners = profile.corners.map(clone) as ExtrusionEntity['corners'];
  }

  private get minSize(): number {
    return this.step > 0 ? this.step : 1;
  }

  get face(): ProfileFace {
    return this.currentFaces()[this.faceIndex] ?? this.faces[this.faceIndex];
  }

  get dragging(): boolean { return this.grab !== null; }

  get preview(): ExtrusionEntity {
    return { id: this.profile.id, type: 'extrusion', corners: this.corners, depth: this.depth };
  }

  /** Total outward distance the active face has been pulled so far (mm). */
  get pulled(): number { return this.pull; }

  /** Frozen grab baseline + first clear pull direction for voice, or null before 12 px of movement. */
  get measurement(): FacePullMeasurement | null {
    return this.measurementState ? structuredClone(this.measurementState) : null;
  }

  /** Faces of the current preview; the active face's quad lives here. */
  currentFaces(): ProfileFace[] {
    return profileFaces(this.preview);
  }

  /** Keep this.faces' quads/centers glued to the preview by (axis, sign). */
  private refreshFaces(): void {
    const current = this.currentFaces();
    for (const [index, face] of this.faces.entries()) {
      const match = current.find((candidate) => candidate.axis === face.axis && candidate.sign === face.sign);
      if (match) this.faces[index] = match;
    }
  }

  private applyPull(pull: number): void {
    const result = pushPull(this.base, this.face, pull, this.minSize);
    this.pull = pull;
    this.corners = result.corners;
    this.depth = result.depth;
    this.refreshFaces();
  }

  /** Switch face; only allowed when not dragging. Snapshots current geometry as the new base. */
  setFace(index: number): boolean {
    if (this.dragging || index < 0 || index >= this.faces.length) return false;
    if (index === this.faceIndex) return true;
    this.faceIndex = index;
    this.base = this.preview;
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
      const base: ProfileEntity = this.profile.type === 'rect' && this.depth === 0
        ? { id: this.profile.id, type: 'rect', corners: structuredClone(this.corners) }
        : structuredClone(this.preview);
      const face = this.face;
      this.grab = { position: { ...position }, pull: this.pull, base, axis: face.axis, sign: face.sign };
      this.measurementState = null;
      return;
    }
    // Round the delta, so starting a drag never changes an existing exact depth.
    const pixels = dot2(sub2(position, this.grab.position), along);
    const delta = pixels * this.mmPerPixel;
    if (!this.measurementState && Math.abs(pixels) >= 12 && Number.isFinite(delta) && delta !== 0) {
      this.measurementState = {
        base: structuredClone(this.grab.base), axis: this.grab.axis, sign: this.grab.sign,
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
  setPull(distance: number): void {
    if (!Number.isFinite(distance)) return;
    this.measurementState = null;
    this.applyPull(distance);
    this.pause();
  }

  /** Set the signed depth directly; the current geometry becomes the new base. */
  setDepth(depth: number): void {
    if (!Number.isFinite(depth)) return;
    this.depth = depth;
    this.base = this.preview;
    this.pull = 0;
    this.measurementState = null;
    this.refreshFaces();
    this.pause();
  }
}
