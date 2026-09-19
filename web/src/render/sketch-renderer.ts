import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { cylinderTopCenter, entityCenter, entitySegments, entityTriangles, entityVertices, extrusionOffset, formatMm, lineLength, rectFrame, type Entity, type SolidEntity } from '../model/sketch';
import type { ProfileFace } from '../model/faces';
import { add, lerp, v3 } from '../model/vec';
import type { Vec3 } from '../model/vec';
import type { Viewport } from '../scene/viewport';

export const COLORS = {
  line: 0xf2f4f8,
  face: 0x8ab4f8,
  hover: 0xffc857,
  ghost: 0x6fe3b4,
  ink: 0x9aa4b2,
  vertex: 0xffffff,
  fade: 0xff6b6b,
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
  if (entity.type === 'cylinder') return `Ø ${formatMm(entity.radius * 2)} × ${formatMm(entity.depth)}`;
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
  private readonly ghostMaterial: LineMaterial;
  private readonly fadeMaterial: LineMaterial;
  private lines: LineSegments2;
  private hover: LineSegments2;
  private readonly selected: LineSegments2;
  private readonly extrusionLines: LineSegments2;
  private readonly extrusionFaces: THREE.Mesh;
  private readonly activeFace: THREE.Mesh;
  private readonly activeFaceOutline: LineSegments2;
  private ghost: Line2;
  private fadeLine: Line2;
  private fadeUntil = 0;
  private readonly ink: THREE.Line;
  private readonly faces: THREE.Mesh;
  private readonly vertices: THREE.Points;
  private readonly ghostLabel = new Label('dim-label--ghost');
  private readonly hoverLabel = new Label('dim-label--hover');
  private readonly lastLabel = new Label('dim-label--last');
  private readonly extrusionLabel = new Label('dim-label--ghost');

  constructor(private readonly viewport: Viewport) {
    this.group.name = 'sketch';
    this.lineMaterial = new LineMaterial({ color: COLORS.line, linewidth: 3, resolution: this.resolution });
    this.hoverMaterial = new LineMaterial({ color: COLORS.hover, linewidth: 5, resolution: this.resolution, depthTest: false });
    this.ghostMaterial = new LineMaterial({
      color: COLORS.ghost,
      linewidth: 3,
      resolution: this.resolution,
      dashed: true,
      dashSize: 40,
      gapSize: 25,
      depthTest: false,
    });
    this.fadeMaterial = new LineMaterial({ color: COLORS.fade, linewidth: 3, resolution: this.resolution, transparent: true, opacity: 0.9, depthTest: false });

    this.lines = new LineSegments2(new LineSegmentsGeometry(), this.lineMaterial);
    this.hover = new LineSegments2(new LineSegmentsGeometry(), this.hoverMaterial);
    this.selected = new LineSegments2(new LineSegmentsGeometry(), this.hoverMaterial);
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
    this.fadeLine = new Line2(new LineGeometry(), this.fadeMaterial);
    this.lines.visible = false;
    this.hover.visible = false;
    this.ghost.visible = false;
    this.fadeLine.visible = false;
    this.hover.renderOrder = 5;
    this.ghost.renderOrder = 6;

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
      new THREE.PointsMaterial({ color: COLORS.vertex, size: 9, sizeAttenuation: false, map: circleTexture(), transparent: true, depthTest: false }),
    );
    this.vertices.visible = false;
    this.vertices.renderOrder = 7;

    this.group.add(this.faces, this.lines, this.hover, this.selected, this.ink, this.fadeLine, this.ghost, this.vertices, this.extrusionFaces, this.extrusionLines, this.activeFace, this.activeFaceOutline);
    this.group.add(this.ghostLabel.object, this.hoverLabel.object, this.lastLabel.object, this.extrusionLabel.object);
    viewport.scene.add(this.group);
    viewport.onResize(() => this.updateResolution());
    this.updateResolution();
  }

  private updateResolution(): void {
    this.resolution.set(this.viewport.width, this.viewport.height);
    // LineMaterial copies the vector on assignment, so push the new size to every material.
    for (const material of [this.lineMaterial, this.hoverMaterial, this.ghostMaterial, this.fadeMaterial]) {
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
    if (!entity) {
      this.hover.visible = false;
      this.hoverLabel.set(null);
      return;
    }
    const positions: number[] = [];
    for (const segment of entitySegments(entity)) positions.push(...flatten([segment.a, segment.b]));
    this.replaceSegments(this.hover, positions);
    this.hoverLabel.set(entityLabel(entity), entityCenter(entity));
  }

  setLastLabel(entity: Entity | null): void {
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
    const top = entity
      ? entity.type === 'cylinder'
        ? cylinderTopCenter(entity)
        : add(lerp(entity.corners[0], entity.corners[2], 0.5), extrusionOffset(entity))
      : undefined;
    this.extrusionLabel.set(entity ? `Depth ${formatMm(entity.depth)}` : null, top);
    this.lastLabel.object.visible = false;
  }

  /** Highlight the face currently being pushed/pulled during an extrusion. */
  setActiveFace(face: Pick<ProfileFace, 'outline' | 'center'> | readonly Vec3[] | null, center?: Vec3): void {
    const profileFace = face && !Array.isArray(face) ? face as Pick<ProfileFace, 'outline' | 'center'> : null;
    const outline = Array.isArray(face) ? face : profileFace?.outline;
    const faceCenter = Array.isArray(face) ? center : profileFace?.center;
    if (!outline || outline.length < 3) {
      this.activeFace.visible = false;
      this.activeFaceOutline.visible = false;
      return;
    }
    const centre = faceCenter ?? outline.reduce((sum: Vec3, point: Vec3) => add(sum, point), v3(0, 0, 0));
    if (!faceCenter) {
      centre.x /= outline.length;
      centre.y /= outline.length;
      centre.z /= outline.length;
    }
    this.activeFace.geometry.dispose();
    const fill: Vec3[] = [];
    for (let index = 0; index < outline.length; index += 1) {
      fill.push(centre, outline[index], outline[(index + 1) % outline.length]);
    }
    this.activeFace.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(flatten(fill), 3));
    this.activeFace.visible = true;
    this.activeFaceOutline.geometry.dispose();
    const outlineGeometry = new LineSegmentsGeometry();
    const ring: Vec3[] = [];
    for (let index = 0; index < outline.length; index += 1) ring.push(outline[index], outline[(index + 1) % outline.length]);
    outlineGeometry.setPositions(flatten(ring));
    this.activeFaceOutline.geometry = outlineGeometry;
    this.activeFaceOutline.visible = true;
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
