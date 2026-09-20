import * as THREE from 'three';
import type { OrbitController } from './orbit';
import type { Viewport } from './viewport';

export const AXIS_COLORS = { x: 0xe5534b, y: 0x57ab5a, z: 0x539bf5 } as const;

function lineSegments(points: number[], color: number, opacity: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  return new THREE.LineSegments(geometry, material);
}

/** Static ground grid on Z = 0 with coloured world axes. */
export function createGroundGrid(halfSize = 10000, minor = 100, major = 1000): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ground-grid';
  const minorPoints: number[] = [];
  const majorPoints: number[] = [];
  for (let value = -halfSize; value <= halfSize + 1e-6; value += minor) {
    if (Math.abs(value) < 1e-6) continue;
    const isMajor = Math.abs(value % major) < 1e-6;
    const bucket = isMajor ? majorPoints : minorPoints;
    bucket.push(value, -halfSize, 0, value, halfSize, 0);
    bucket.push(-halfSize, value, 0, halfSize, value, 0);
  }
  group.add(lineSegments(minorPoints, 0x2a2d31, 0.5));
  group.add(lineSegments(majorPoints, 0x363a40, 0.7));
  group.add(lineSegments([-halfSize, 0, 0, halfSize, 0, 0], AXIS_COLORS.x, 0.8));
  group.add(lineSegments([0, -halfSize, 0, 0, halfSize, 0], AXIS_COLORS.y, 0.8));
  group.add(lineSegments([0, 0, 0, 0, 0, halfSize / 4], AXIS_COLORS.z, 0.8));
  group.renderOrder = -10;
  return group;
}

function letterSprite(letter: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.font = 'bold 44px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  context.fillText(letter, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.setScalar(0.55);
  return sprite;
}

/** Small orientation gizmo rendered in the bottom-left corner. */
export class AxisTriad {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
  readonly size = 96;
  readonly margin = 14;

  constructor() {
    const axes: [keyof typeof AXIS_COLORS, THREE.Vector3][] = [
      ['x', new THREE.Vector3(1, 0, 0)],
      ['y', new THREE.Vector3(0, 1, 0)],
      ['z', new THREE.Vector3(0, 0, 1)],
    ];
    for (const [name, direction] of axes) {
      const color = AXIS_COLORS[name];
      this.scene.add(new THREE.ArrowHelper(direction, new THREE.Vector3(), 1, color, 0.25, 0.14));
      const label = letterSprite(name.toUpperCase(), color);
      label.position.copy(direction).multiplyScalar(1.3);
      this.scene.add(label);
    }
    this.camera.up.set(0, 0, 1);
  }

  render(viewport: Viewport, orbit: OrbitController): void {
    const { up } = orbit.basis();
    const direction = orbit.position.clone().sub(orbit.target).normalize();
    this.camera.position.copy(direction).multiplyScalar(6);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
    const renderer = viewport.renderer;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setScissor(this.margin, this.margin, this.size, this.size);
    renderer.setViewport(this.margin, this.margin, this.size, this.size);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, viewport.width, viewport.height);
    renderer.autoClear = true;
  }
}
