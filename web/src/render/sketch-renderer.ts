import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { entityCenter, entitySegments, entityTriangles, entityVertices, extrusionOffset, formatMm, isRectangleProfile, lineLength, rectFrame, type Entity, type SolidEntity } from '../model/sketch';
import type { EdgeGuide } from '../model/edge-inference';
import type { ProfileFace } from '../model/faces';
import { triangulatePolygon } from '../model/polygon';
import { add, cross, normalize, scale, sub } from '../model/vec';
import type { Vec3 } from '../model/vec';
import type { Viewport } from '../scene/viewport';
import { THREE_COLORS } from '../ui/theme';

export const COLORS = {
  line: 0xd5d9df,
  face: THREE_COLORS.accent,
  hover: THREE_COLORS.hoverSnap,
  ghost: THREE_COLORS.preview,
  ink: 0x9aa4b2,
  vertex: 0xc8cdd3,
  fade: THREE_COLORS.textSecondary,
  guide: THREE_COLORS.accent,
};

function flatten(points: readonly Vec3[]): number[] {
  const out: number[] = [];
  for (const p of points) out.push(p.x, p.y, p.z);
  return out;
}

function circleTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.arc(16, 16, 12, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#20242b';
  context.lineWidth = 3;
  context.stroke();
  return new THREE.CanvasTexture(canvas);
}

class Label {
  readonly object: CSS2DObject;
  readonly element: HTMLDivElement;

  constructor(className: string) {
    this.element = document.createElement('div');
    this.element.className = `dim-label ${className}`;
    this.object = new CSS2DObject(this.element);
    this.object.visible = false;
  }

  set(text: string | null, at?: Vec3): void {
    if (!text || !at) {
      this.object.visible = false;
      return;
    }
    this.element.textContent = text;
    this.object.position.set(at.x, at.y, at.z);
    this.object.visible = true;
  }
}

export function entityLabel(entity: Entity): string {
  if (entity.type === 'line') return formatMm(lineLength(entity));
  if (entity.type === 'circle') return `Ø ${formatMm(entity.radius * 2)}`;
  if (entity.type === 'triangle') return 'Triangle';
  if (entity.type === 'prism') return `Depth ${formatMm(entity.depth)}`;
  if (!isRectangleProfile(entity.corners)) {
    return entity.type === 'extrusion'
      ? `${entity.corners.length} edges × ${formatMm(entity.depth)}`
      : `${entity.corners.length} edges`;
  }
  const { width, height } = rectFrame(entity);
  if (entity.type === 'extrusion') return `${formatMm(width).replace(' mm', '')} × ${formatMm(height).replace(' mm', '')} × ${formatMm(entity.depth)}`;
  return `${formatMm(width).replace(' mm', '')} × ${formatMm(height)}`;
}

/** Draws committed entities, hover highlight, live ink, the recognition ghost and dimension labels. */
export class SketchRenderer {
  readonly group = new THREE.Group();
  private readonly resolution = new THREE.Vector2(1, 1);
  private readonly lineMaterial: LineMaterial;
  private readonly hoverMaterial: LineMaterial;
  private readonly selectionMaterial: LineMaterial;
  private readonly ghostMaterial: LineMaterial;
  private readonly guideMaterial: LineMaterial;
  private readonly fadeMaterial: LineMaterial;
  private lines: LineSegments2;
  private hover: LineSegments2;
  private readonly selected: LineSegments2;
  private readonly extrusionLines: LineSegments2;
  private readonly extrusionFaces: THREE.Mesh;
  private readonly activeFace: THREE.Mesh;
  private readonly activeFaceOutline: LineSegments2;
  private ghost: Line2;
  private readonly lineGuide: Line2;
  private fadeLine: Line2;
  private fadeUntil = 0;
  private hoverEntity: Entity | null = null;
  private lastLabelEntity: Entity | null = null;
  /** While an extrusion preview is up, its depth label replaces the last-committed one. */
  private extrusionActive = false;
  private readonly ink: THREE.Line;
  private readonly faces: THREE.Mesh;
  private readonly vertices: THREE.Points;
  private readonly ghostLabel = new Label('dim-label--ghost');
  private readonly guideLabel = new Label('dim-label--guide');
  private readonly hoverLabel = new Label('dim-label--hover');
  private readonly lastLabel = new Label('dim-label--last');
  private readonly extrusionLabel = new Label('dim-label--ghost');
  private readonly edgeGuideMaterial: LineMaterial;
  private readonly guideReferenceMaterial: LineMaterial;
  private readonly guideLines: LineSegments2;
  private readonly guideReference: LineSegments2;
  private readonly edgeGuideLabel = new Label('dim-label--ghost');
  private currentGuide: EdgeGuide | null = null;

  constructor(private readonly viewport: Viewport) {
    this.group.name = 'sketch';
    this.lineMaterial = new LineMaterial({ color: COLORS.line, linewidth: 2, resolution: this.resolution });
    this.hoverMaterial = new LineMaterial({ color: COLORS.hover, linewidth: 3, resolution: this.resolution, depthTest: false });
    this.ghostMaterial = new LineMaterial({
      color: COLORS.ghost,
      linewidth: 2,
      resolution: this.resolution,
      dashed: true,
      dashSize: 40,
      gapSize: 25,
      depthTest: false,
    });
    this.guideMaterial = new LineMaterial({
      color: COLORS.guide, linewidth: 2, resolution: this.resolution,
      dashed: true, dashSize: 40, gapSize: 25,
      depthTest: false, transparent: true, opacity: 0.8,
    });
    this.fadeMaterial = new LineMaterial({ color: COLORS.fade, linewidth: 2, resolution: this.resolution, transparent: true, opacity: 0.9, depthTest: false });

    // Persistent selection reads differently from transient hover: accent, not amber.
    this.selectionMaterial = new LineMaterial({ color: THREE_COLORS.accent, linewidth: 3, resolution: this.resolution, depthTest: false });

    this.lines = new LineSegments2(new LineSegmentsGeometry(), this.lineMaterial);
    this.hover = new LineSegments2(new LineSegmentsGeometry(), this.hoverMaterial);
    this.selected = new LineSegments2(new LineSegmentsGeometry(), this.selectionMaterial);
    this.extrusionLines = new LineSegments2(new LineSegmentsGeometry(), this.ghostMaterial);
    this.extrusionFaces = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: COLORS.ghost, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.activeFace = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: COLORS.hover, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.activeFaceOutline = new LineSegments2(new LineSegmentsGeometry(), this.hoverMaterial);
    this.selected.visible = false;
    this.extrusionLines.visible = false;
    this.extrusionFaces.visible = false;
    this.activeFace.visible = false;
    this.activeFaceOutline.visible = false;
    this.selected.renderOrder = 5;
    this.extrusionLines.renderOrder = 6;
    this.activeFace.renderOrder = 6;
    this.activeFaceOutline.renderOrder = 6;
    this.ghost = new Line2(new LineGeometry(), this.ghostMaterial);
    this.lineGuide = new Line2(new LineGeometry(), this.guideMaterial);
    this.lineGuide.visible = false;
    this.lineGuide.renderOrder = 5;
    this.fadeLine = new Line2(new LineGeometry(), this.fadeMaterial);
    this.lines.visible = false;
    this.hover.visible = false;
    this.ghost.visible = false;
    this.fadeLine.visible = false;
    this.hover.renderOrder = 5;
    this.ghost.renderOrder = 6;

    this.edgeGuideMaterial = new LineMaterial({ color: COLORS.ghost, linewidth: 1.5, resolution: this.resolution, dashed: true, dashSize: 40, gapSize: 25, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false });
    this.guideReferenceMaterial = new LineMaterial({ color: COLORS.hover, linewidth: 2.5, resolution: this.resolution, depthTest: false, depthWrite: false });
    this.guideLines = new LineSegments2(new LineSegmentsGeometry(), this.edgeGuideMaterial);
    this.guideReference = new LineSegments2(new LineSegmentsGeometry(), this.guideReferenceMaterial);
    this.guideLines.name = 'edge-guide';
    this.guideReference.name = 'edge-reference';
    this.edgeGuideLabel.object.name = 'edge-guide-label';
    this.guideLines.visible = false;
    this.guideReference.visible = false;
    this.guideLines.renderOrder = 5;
    this.guideReference.renderOrder = 5;

    this.ink = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COLORS.ink, transparent: true, opacity: 0.7, depthTest: false }),
    );
    this.ink.visible = false;
    this.ink.renderOrder = 4;

    this.faces = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: COLORS.face, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.faces.visible = false;

    this.vertices = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: COLORS.vertex, size: 7, sizeAttenuation: false, map: circleTexture(), transparent: true, depthTest: false }),
    );
    this.vertices.visible = false;
    this.vertices.renderOrder = 7;

    this.group.add(this.faces, this.lines, this.hover, this.selected, this.ink, this.fadeLine, this.ghost, this.lineGuide, this.vertices, this.extrusionFaces, this.extrusionLines, this.activeFace, this.activeFaceOutline, this.guideLines, this.guideReference);
    this.group.add(this.ghostLabel.object, this.guideLabel.object, this.hoverLabel.object, this.lastLabel.object, this.extrusionLabel.object, this.edgeGuideLabel.object);
    viewport.scene.add(this.group);
    viewport.onResize(() => this.updateResolution());
    this.updateResolution();
  }

  private updateResolution(): void {
    this.resolution.set(this.viewport.width, this.viewport.height);
    // LineMaterial copies the vector on assignment, so push the new size to every material.
    for (const material of [this.lineMaterial, this.hoverMaterial, this.selectionMaterial, this.ghostMaterial, this.guideMaterial, this.fadeMaterial, this.edgeGuideMaterial, this.guideReferenceMaterial]) {
      material.resolution = this.resolution;
    }
  }

  private replaceSegments(target: LineSegments2, positions: number[]): LineSegments2 {
    target.geometry.dispose();
    const geometry = new LineSegmentsGeometry();
    if (positions.length) geometry.setPositions(positions);
    target.geometry = geometry;
    target.visible = positions.length > 0;
    return target;
  }

  private replacePolyline(target: Line2, positions: number[]): void {
    target.geometry.dispose();
    const geometry = new LineGeometry();
    if (positions.length >= 6) geometry.setPositions(positions);
    target.geometry = geometry;
    target.visible = positions.length >= 6;
    if (target.visible) target.computeLineDistances();
  }

  setSketch(entities: readonly Entity[]): void {
    const segmentPositions: number[] = [];
    const facePositions: number[] = [];
    const vertexPositions: number[] = [];
    for (const entity of entities) {
      for (const segment of entitySegments(entity)) segmentPositions.push(...flatten([segment.a, segment.b]));
      for (const vertex of entityVertices(entity)) vertexPositions.push(vertex.point.x, vertex.point.y, vertex.point.z);
      for (const triangle of entityTriangles(entity)) facePositions.push(...flatten(triangle));
    }
    this.replaceSegments(this.lines, segmentPositions);

    this.faces.geometry.dispose();
    this.faces.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(facePositions, 3));
    this.faces.visible = facePositions.length > 0;

    this.vertices.geometry.dispose();
    this.vertices.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(vertexPositions, 3));
    this.vertices.visible = vertexPositions.length > 0;
  }

  setHover(entity: Entity | null): void {
    this.hoverEntity = entity;
    if (!entity) {
      this.hover.visible = false;
      this.hoverLabel.set(null);
      this.syncEntityLabels();
      return;
    }
    const positions: number[] = [];
    for (const segment of entitySegments(entity)) positions.push(...flatten([segment.a, segment.b]));
    this.replaceSegments(this.hover, positions);
    this.hoverLabel.set(entityLabel(entity), entityCenter(entity));
    this.syncEntityLabels();
  }

  setLastLabel(entity: Entity | null): void {
    this.lastLabelEntity = entity;
    this.syncEntityLabels();
  }

  /**
   * Hover and last-committed labels share an entity's center; when they name
   * the same object keep the hover label and drop the duplicate.
   */
  private syncEntityLabels(): void {
    const duplicate =
      this.hoverEntity !== null && this.lastLabelEntity !== null && this.hoverEntity.id === this.lastLabelEntity.id;
    const entity = duplicate || this.extrusionActive ? null : this.lastLabelEntity;
    this.lastLabel.set(entity ? entityLabel(entity) : null, entity ? entityCenter(entity) : undefined);
  }

  setSelected(entity: Entity | null): void {
    this.replaceSegments(this.selected, entity ? entitySegments(entity).flatMap((edge) => flatten([edge.a, edge.b])) : []);
  }

  /** A separate preview mesh keeps the committed model and undo history untouched. */
  setExtrusion(entity: SolidEntity | null): void {
    this.replaceSegments(this.extrusionLines, entity ? entitySegments(entity).flatMap((edge) => flatten([edge.a, edge.b])) : []);
    if (entity) this.extrusionLines.computeLineDistances();
    const positions = entity ? entityTriangles(entity).flatMap((triangle) => flatten(triangle)) : [];
    this.extrusionFaces.geometry.dispose();
    this.extrusionFaces.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.extrusionFaces.visible = positions.length > 0;
    const top = entity ? add(entityCenter(entity), scale(extrusionOffset(entity), 0.5)) : undefined;
    this.extrusionLabel.set(entity ? `Depth ${formatMm(entity.depth)}` : null, top);
    this.extrusionActive = !!entity;
    this.syncEntityLabels();
  }

  /** Highlight the face currently being pushed/pulled during an extrusion. */
  setActiveFace(face: Pick<ProfileFace, 'quad' | 'center'> | null): void {
    const outline = face?.quad;
    const faceCenter = face?.center;
    if (!outline || outline.length < 3) {
      this.activeFace.visible = false;
      this.activeFaceOutline.visible = false;
      return;
    }
    const positions = triangulatePolygon(outline as Vec3[]).flatMap(flatten);
    this.activeFace.geometry.dispose();
    this.activeFace.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.activeFace.visible = positions.length > 0;
    this.activeFaceOutline.geometry.dispose();
    const outlineGeometry = new LineSegmentsGeometry();
    outlineGeometry.setPositions(outline.flatMap((point, index) => flatten([point, outline[(index + 1) % outline.length]])));
    this.activeFaceOutline.geometry = outlineGeometry;
    this.activeFaceOutline.visible = true;
    void faceCenter;
  }

  setLineGuide(points: readonly Vec3[] | null, label: { text: string; at: Vec3 } | null): void {
    if (!points || points.length < 2) {
      this.lineGuide.visible = false;
      this.guideLabel.set(null);
      return;
    }
    this.replacePolyline(this.lineGuide, flatten(points));
    this.guideLabel.set(label?.text ?? null, label?.at);
  }

  /** Live raw ink while the pen is down. */
  setInk(path: readonly Vec3[] | null): void {
    if (!path || path.length < 2) {
      this.ink.visible = false;
      return;
    }
    this.ink.geometry.dispose();
    this.ink.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(flatten(path), 3));
    this.ink.visible = true;
  }

  setEdgeGuide(guide: EdgeGuide | null): void {
    if (guide === this.currentGuide) return;
    this.currentGuide = guide;
    if (!guide) {
      this.guideLines.visible = false;
      this.guideReference.visible = false;
      this.edgeGuideLabel.set(null);
      return;
    }
    const unit = this.viewport.worldPerPixel(guide.target);
    this.edgeGuideMaterial.dashSize = 6 * unit;
    this.edgeGuideMaterial.gapSize = 4 * unit;
    const direction = normalize(sub(guide.target, guide.start));
    const tick = scale(normalize(cross(guide.normal, direction)), 5 * unit);
    this.replaceSegments(this.guideReference, flatten([guide.reference.a, guide.reference.b]));
    this.replaceSegments(this.guideLines, flatten([
      guide.start, guide.target,
      guide.reference.a, guide.start,
      guide.reference.b, guide.target,
      sub(guide.start, tick), add(guide.start, tick),
      sub(guide.target, tick), add(guide.target, tick),
    ]));
    this.guideLines.computeLineDistances();
    this.edgeGuideLabel.set(
      guide.matchedLength ? `Equal length · ${formatMm(guide.targetLength)}` : `Parallel · ${formatMm(guide.targetLength)} suggested`,
      add(guide.target, scale(tick, 2)),
    );
  }

  /** Dashed recognition preview with a dimension label. */
  setGhost(points: readonly Vec3[] | null, closed: boolean, label: { text: string; at: Vec3 } | null): void {
    if (!points || points.length < 2) {
      this.ghost.visible = false;
      this.ghostLabel.set(null);
      return;
    }
    const path = closed ? [...points, points[0]] : [...points];
    this.replacePolyline(this.ghost, flatten(path));
    this.ghostLabel.set(label?.text ?? null, label?.at);
  }

  /** Show an unrecognised stroke briefly in red, then fade it out. */
  fadeOut(path: readonly Vec3[], durationMs = 700): void {
    if (path.length < 2) return;
    this.replacePolyline(this.fadeLine, flatten(path));
    this.fadeMaterial.opacity = 0.9;
    this.fadeUntil = performance.now() + durationMs;
  }

  /** Advance animations; call once per frame. */
  tick(nowMs: number): void {
    if (!this.fadeLine.visible) return;
    const remaining = this.fadeUntil - nowMs;
    if (remaining <= 0) {
      this.fadeLine.visible = false;
      return;
    }
    this.fadeMaterial.opacity = 0.9 * Math.min(1, remaining / 500);
  }
}
