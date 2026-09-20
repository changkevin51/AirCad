import * as THREE from 'three';
import type { WorkPlane } from '../model/plane';
import { roundTo, type Vec2 } from '../model/vec';
import { THREE_COLORS } from '../ui/theme';
import { AXIS_COLORS } from './grid';

/** Translucent work-plane quad with its own adaptive grid, tinted by the plane normal. */
export class WorkPlaneVisual {
  readonly group = new THREE.Group();
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly minor: THREE.LineSegments;
  private readonly major: THREE.LineSegments;
  private readonly outline: THREE.LineLoop;
  private readonly anchorMarker: THREE.Sprite;
  private signature = '';

  constructor() {
    this.group.name = 'work-plane';
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: THREE_COLORS.accent, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.quad.renderOrder = -5;
    this.minor = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    this.major = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.outline = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d')!;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(16, 2);
    context.lineTo(16, 30);
    context.moveTo(2, 16);
    context.lineTo(30, 16);
    context.stroke();
    this.anchorMarker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true, opacity: 0.9, sizeAttenuation: false }),
    );
    this.anchorMarker.scale.setScalar(0.03);
    this.anchorMarker.renderOrder = 20;
    this.group.add(this.quad, this.minor, this.major, this.outline, this.anchorMarker);
  }

  /**
   * Rebuild when the plane, grid step or focus changes.  `focus` is a plane
   * coordinate the grid is centred on (normally the cursor or the anchor).
   */
  update(plane: WorkPlane, step: number, focus: Vec2, cells = 40): void {
    const majorStep = step * 10;
    const centre = { x: roundTo(focus.x, majorStep), y: roundTo(focus.y, majorStep) };
    const signature = `${plane.kind}|${plane.offset.toFixed(3)}|${step}|${centre.x}|${centre.y}|${cells}`;
    const anchor = plane.anchor;
    this.anchorMarker.position.set(anchor.x, anchor.y, anchor.z);
    if (signature === this.signature) return;
    this.signature = signature;

    // The fill stays accent-tinted; the grid and boundary keep the axis color.
    const color = new THREE.Color(AXIS_COLORS[plane.info.normalAxis]);
    for (const material of [this.minor.material, this.major.material, this.outline.material]) {
      (material as THREE.LineBasicMaterial).color.copy(color);
    }

    const half = cells * step;
    const uMin = centre.x - half;
    const uMax = centre.x + half;
    const vMin = centre.y - half;
    const vMax = centre.y + half;
    const toWorld = (u: number, v: number): [number, number, number] => {
      const p = plane.toWorld({ x: u, y: v });
      return [p.x, p.y, p.z];
    };

    const minorPoints: number[] = [];
    const majorPoints: number[] = [];
    for (let i = -cells; i <= cells; i++) {
      const u = centre.x + i * step;
      const v = centre.y + i * step;
      const isMajor = Math.abs(u % majorStep) < 1e-6;
      const bucketU = isMajor ? majorPoints : minorPoints;
      bucketU.push(...toWorld(u, vMin), ...toWorld(u, vMax));
      const isMajorV = Math.abs(v % majorStep) < 1e-6;
      const bucketV = isMajorV ? majorPoints : minorPoints;
      bucketV.push(...toWorld(uMin, v), ...toWorld(uMax, v));
    }
    this.minor.geometry.dispose();
    this.minor.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(minorPoints, 3));
    this.major.geometry.dispose();
    this.major.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(majorPoints, 3));
    this.outline.geometry.dispose();
    this.outline.geometry = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([...toWorld(uMin, vMin), ...toWorld(uMax, vMin), ...toWorld(uMax, vMax), ...toWorld(uMin, vMax)], 3),
    );

    const centreWorld = plane.toWorld(centre);
    this.quad.scale.set(2 * half, 2 * half, 1);
    this.quad.position.set(centreWorld.x, centreWorld.y, centreWorld.z);
    const normal = plane.normal;
    this.quad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(normal.x, normal.y, normal.z));
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }
}
