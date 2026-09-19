import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { entityCenter, entitySegments, entityVertices, formatMm, lineLength, rectFrame, type Entity } from '../model/sketch';
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
  const { width, height } = rectFrame(entity);
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
  private ghost: Line2;
  private fadeLine: Line2;
  private fadeUntil = 0;
  private readonly ink: THREE.Line;
  private readonly faces: THREE.Mesh;
  private readonly vertices: THREE.Points;
  private readonly ghostLabel = new Label('dim-label--ghost');
  private readonly hoverLabel = new Label('dim-label--hover');
  private readonly lastLabel = new Label('dim-label--last');

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

    this.group.add(this.faces, this.lines, this.hover, this.ink, this.fadeLine, this.ghost, this.vertices);
    this.group.add(this.ghostLabel.object, this.hoverLabel.object, this.lastLabel.object);
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
      if (entity.type === 'rect') {
        const [a, b, c, d] = entity.corners;
        facePositions.push(...flatten([a, b, c, a, c, d]));
      }
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
