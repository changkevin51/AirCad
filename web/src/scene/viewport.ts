import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Projector } from '../model/snap';
import { v2, v3, type Vec2, type Vec3 } from '../model/vec';
import { THREE_COLORS } from '../ui/theme';

// CAD convention: Z is up.  Must run before any camera/object is created.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export const CAMERA_FOV_DEG = 45;

/**
 * Owns the WebGL + CSS2D renderers, the scene and both cameras.  Everything
 * that needs world <-> screen conversions goes through `projector()` so the
 * model layer never touches three.js.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly perspective: THREE.PerspectiveCamera;
  readonly orthographic: THREE.OrthographicCamera;
  ortho = false;
  width = 1;
  height = 1;
  private readonly resizeListeners = new Set<() => void>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly scratch = new THREE.Vector3();

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = 'gl-canvas';
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.scene.background = new THREE.Color(THREE_COLORS.canvas);
    this.perspective = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 10, 1e6);
    this.orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    this.perspective.up.set(0, 0, 1);
    this.orthographic.up.set(0, 0, 1);

    // A small fixed studio rig for the Shaded display style: hemisphere fill
    // from +Z (up) plus one key light; Basic-material X-ray ignores both.
    const fill = new THREE.HemisphereLight(0xffffff, 0x46515f, 0.75);
    fill.position.set(0, 0, 1);
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(4, -6, 9);
    this.scene.add(fill, key);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.ortho ? this.orthographic : this.perspective;
  }

  get aspect(): number {
    return this.width / Math.max(1, this.height);
  }

  onResize(listener: () => void): () => void {
    this.resizeListeners.add(listener);
    return () => this.resizeListeners.delete(listener);
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    for (const listener of this.resizeListeners) listener();
  }

  render(): void {
    const camera = this.camera;
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.scene, camera);
    this.labelRenderer.render(this.scene, camera);
  }

  /** Camera forward direction in world space. */
  viewDirection(): Vec3 {
    const direction = this.camera.getWorldDirection(this.scratch);
    return v3(direction.x, direction.y, direction.z);
  }

  /** World millimetres represented by one screen pixel at `world`. */
  worldPerPixel(world: Vec3): number {
    const camera = this.syncCamera();
    if (this.ortho) {
      return (this.orthographic.top - this.orthographic.bottom) / Math.max(1, this.height);
    }
    const pos = camera.position;
    const dist = Math.hypot(world.x - pos.x, world.y - pos.y, world.z - pos.z);
    const fov = (CAMERA_FOV_DEG * Math.PI) / 180;
    return (2 * Math.max(1, dist) * Math.tan(fov / 2)) / Math.max(1, this.height);
  }

  project(world: Vec3): Vec2 | null {
    const camera = this.syncCamera();
    const point = this.scratch.set(world.x, world.y, world.z);
    point.applyMatrix4(camera.matrixWorldInverse);
    if (!this.ortho && point.z > -1e-6) return null;
    point.applyMatrix4(camera.projectionMatrix);
    return v2(((point.x + 1) / 2) * this.width, ((1 - point.y) / 2) * this.height);
  }

  ray(screen: Vec2): { origin: Vec3; dir: Vec3 } {
    const camera = this.syncCamera();
    const ndc = new THREE.Vector2((screen.x / this.width) * 2 - 1, -(screen.y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, camera);
    const { origin, direction } = this.raycaster.ray;
    return { origin: v3(origin.x, origin.y, origin.z), dir: v3(direction.x, direction.y, direction.z) };
  }

  projector(): Projector {
    // The camera may have moved since the last render; refresh both matrices
    // so projections in this frame match what will be drawn.
    this.syncCamera();
    return {
      project: (world) => this.project(world),
      ray: (screen) => this.ray(screen),
      worldPerPixel: (world) => this.worldPerPixel(world),
    };
  }

  private syncCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    const camera = this.camera;
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    return camera;
  }
}
