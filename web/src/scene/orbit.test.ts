import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OrbitController } from './orbit';
import { CAMERA_FOV_DEG } from './viewport';
import { v2, v3, type Vec2, type Vec3 } from '../model/vec';

const DEG = Math.PI / 180;

function makeViewport(width = 800, height = 600) {
  const perspective = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, width / height, 10, 1e6);
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
  perspective.aspect = width / height;
  perspective.updateProjectionMatrix();
  const raycaster = new THREE.Raycaster();
  let ortho = false;
  const active = (): THREE.PerspectiveCamera | THREE.OrthographicCamera => (ortho ? orthographic : perspective);
  const view = {
    perspective,
    orthographic,
    width,
    height,
    get ortho() {
      return ortho;
    },
    set ortho(value: boolean) {
      ortho = value;
    },
    get aspect() {
      return width / Math.max(1, height);
    },
    onResize: (_listener: () => void) => () => {},
    ray(screen: Vec2) {
      const ndc = new THREE.Vector2((screen.x / width) * 2 - 1, -(screen.y / height) * 2 + 1);
      raycaster.setFromCamera(ndc, active());
      const { origin, direction } = raycaster.ray;
      return { origin: v3(origin.x, origin.y, origin.z), dir: v3(direction.x, direction.y, direction.z) };
    },
  };
  const project = (world: Vec3): Vec2 | null => {
    const camera = active();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const point = new THREE.Vector3(world.x, world.y, world.z).applyMatrix4(camera.matrixWorldInverse);
    if (!ortho && point.z > -1e-6) return null;
    point.applyMatrix4(camera.projectionMatrix);
    return v2(((point.x + 1) / 2) * width, ((1 - point.y) / 2) * height);
  };
  return { view, project };
}

const directionOf = (orbit: OrbitController): THREE.Vector3 => orbit.position.clone().sub(orbit.target).normalize();

describe('orbit dragging', () => {
  it('keeps an exact Top view untilted for horizontal drags and exits without flips', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('top', false, 0);
    const pivot = v3(0, 0, 0);
    orbit.beginOrbit(pivot);
    orbit.orbit(60, 0, pivot);
    const direction = directionOf(orbit);
    expect(direction.z).toBeCloseTo(1, 12);
    expect(Math.abs(direction.x)).toBeLessThan(1e-9);
    expect(Math.abs(direction.y)).toBeLessThan(1e-9);
    expect(Math.abs(orbit.basis().up.z)).toBeLessThan(1e-9);
    orbit.orbit(8, 20, pivot);
    const tilted = directionOf(orbit);
    expect(tilted.z).toBeGreaterThan(0.9);
    expect(Number.isFinite(orbit.position.x + orbit.position.y + orbit.position.z)).toBe(true);
    expect(orbit.basis().forward.dot(tilted.negate())).toBeCloseTo(1, 9);
    orbit.endOrbit(false);
  });

  it('ignores zero drags without touching pose, matrices, or a running transition', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    const position = orbit.position.clone();
    const target = orbit.target.clone();
    const matrix = view.perspective.matrixWorld.clone();
    orbit.orbit(0, 0, v3(9, 9, 9));
    expect(orbit.position.equals(position)).toBe(true);
    expect(orbit.target.equals(target)).toBe(true);
    expect(view.perspective.matrixWorld.equals(matrix)).toBe(true);
    orbit.setView('front', true, 0);
    expect(orbit.transitioning).toBe(true);
    orbit.orbit(0, 0, v3(9, 9, 9));
    expect(orbit.transitioning).toBe(true);
    orbit.cancelTransition();
  });

  it('clamps at both poles without crossing to the far side', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    const pivot = v3(0, 0, 0);
    orbit.setView('front', false, 0);
    orbit.beginOrbit(pivot);
    orbit.orbit(0, -256, pivot);
    const high = directionOf(orbit);
    expect(Math.asin(THREE.MathUtils.clamp(high.z, -1, 1)) / DEG).toBeCloseTo(88, 0);
    orbit.orbit(0, -10, pivot);
    const top = directionOf(orbit);
    expect(top.z).toBeCloseTo(1, 9);
    expect(top.z).toBeLessThanOrEqual(1 + 1e-12);
    orbit.orbit(0, -400, pivot);
    const past = directionOf(orbit);
    expect(past.z).toBeCloseTo(1, 9);
    expect(Number.isFinite(orbit.position.x + orbit.position.y + orbit.position.z)).toBe(true);
    orbit.orbit(0, 400, pivot);
    const descended = directionOf(orbit);
    expect(descended.z).toBeLessThan(0.5);
    expect(descended.y).toBeLessThan(-0.5);
    orbit.orbit(0, 700, pivot);
    const bottom = directionOf(orbit);
    expect(bottom.z).toBeCloseTo(-1, 9);
    expect(bottom.z).toBeGreaterThanOrEqual(-1 - 1e-12);
    orbit.endOrbit(false);
  });

  it('reverses repeated drags within floating tolerance', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('iso', false, 0);
    const pivot = v3(10, 20, 30);
    const position = orbit.position.clone();
    const direction = directionOf(orbit);
    orbit.orbit(37, -22, pivot);
    orbit.orbit(-37, 22, pivot);
    expect(directionOf(orbit).angleTo(direction)).toBeLessThan(1e-9);
    expect(orbit.position.distanceTo(position)).toBeLessThan(1e-4);
  });

  it.each([false, true])('keeps the captured gesture pivot on the same pixel across pans (ortho=%s)', (ortho) => {
    const { view, project } = makeViewport();
    view.ortho = ortho;
    const orbit = new OrbitController(view);
    const pivot = v3(500, -300, 200);
    orbit.beginOrbit(pivot);
    orbit.orbit(30, 10, v3(0, 0, 0));
    orbit.pan(40, -25);
    orbit.orbit(25, 15, v3(0, 0, 0));
    const before = project(pivot);
    expect(before).not.toBeNull();
    orbit.orbit(40, -10, v3(0, 0, 0));
    const after = project(pivot);
    expect(after).not.toBeNull();
    expect(after!.x).toBeCloseTo(before!.x, 6);
    expect(after!.y).toBeCloseTo(before!.y, 6);
    orbit.endOrbit(false);
  });
});

describe('view transitions', () => {
  it('animates to the exact canonical preset orientation', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    const distance = orbit.distance;
    const target = orbit.target.clone();
    orbit.setView('front', true, 1000);
    expect(orbit.transitioning).toBe(true);
    orbit.update(1090);
    expect(orbit.transitioning).toBe(true);
    const midway = directionOf(orbit);
    expect(midway.y).toBeLessThan(-0.7);
    expect(midway.y).toBeGreaterThan(-0.999);
    orbit.update(1180);
    expect(orbit.transitioning).toBe(false);
    const direction = directionOf(orbit);
    expect(direction.x).toBeCloseTo(0, 9);
    expect(direction.y).toBeCloseTo(-1, 9);
    expect(direction.z).toBeCloseTo(0, 9);
    expect(orbit.basis().up.z).toBeCloseTo(1, 9);
    expect(orbit.distance).toBeCloseTo(distance, 6);
    expect(orbit.target.equals(target)).toBe(true);
  });

  it('cancelTransition(false) holds the current pose and the next input does not jump', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('front', true, 0);
    orbit.update(90);
    const frozen = orbit.position.clone();
    const frozenDirection = directionOf(orbit);
    orbit.cancelTransition(false);
    expect(orbit.transitioning).toBe(false);
    expect(orbit.position.equals(frozen)).toBe(true);
    orbit.pan(5, 0);
    orbit.orbit(3, 0, v3(0, 0, 0));
    const moved = directionOf(orbit).angleTo(frozenDirection);
    expect(moved).toBeGreaterThan(1e-4);
    expect(moved).toBeLessThan(0.1);
  });

  it('cancelTransition(true) lands exactly on the preset', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('right', true, 0);
    orbit.update(60);
    orbit.cancelTransition(true);
    expect(orbit.transitioning).toBe(false);
    expect(directionOf(orbit).x).toBeCloseTo(1, 9);
    expect(orbit.basis().up.z).toBeCloseTo(1, 9);
  });

  it('applies the final pose immediately with reducedMotion or animate=false', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view, { reducedMotion: true });
    orbit.setView('iso', true, 0);
    expect(orbit.transitioning).toBe(false);
    const expected = new THREE.Vector3(1, -1, 1).normalize();
    expect(directionOf(orbit).angleTo(expected)).toBeLessThan(1e-9);

    const instant = new OrbitController(view);
    instant.setView('top', false, 0);
    expect(instant.transitioning).toBe(false);
    expect(directionOf(instant).z).toBeCloseTo(1, 12);
  });

  it('interrupts a running transition at the current pose on new input', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('front', true, 0);
    orbit.update(90);
    orbit.pan(5, 0);
    expect(orbit.transitioning).toBe(false);
    orbit.setView('front', true, 0);
    orbit.update(45);
    const beforeDirection = directionOf(orbit);
    const beforeOrientation = view.perspective.quaternion.clone();
    orbit.orbit(4, 0, v3(0, 0, 0));
    expect(orbit.transitioning).toBe(false);
    expect(directionOf(orbit).angleTo(beforeDirection)).toBeLessThan(0.1);
    const turned = view.perspective.quaternion.angleTo(beforeOrientation);
    expect(turned).toBeGreaterThan(1e-4);
    expect(turned).toBeLessThan(0.1);
  });
});

describe('orbit end settling', () => {
  it('ignores taps and sub-threshold releases without moving', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('front', false, 0);
    const pivot = v3(0, 0, 0);
    orbit.beginOrbit(pivot);
    expect(orbit.endOrbit()).toBeNull();
    orbit.beginOrbit(pivot);
    orbit.orbit(2, 0, pivot);
    const position = orbit.position.clone();
    expect(orbit.endOrbit()).toBeNull();
    expect(orbit.transitioning).toBe(false);
    expect(orbit.position.equals(position)).toBe(true);
  });

  it('does not attract the camera while the gesture is still held', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('front', false, 0);
    orbit.beginOrbit(v3(0, 0, 0));
    orbit.orbit(10, 0, v3(0, 0, 0));
    expect(orbit.transitioning).toBe(false);
    orbit.endOrbit(false);
  });

  it('settles to the nearest preset only within the snap angle', () => {
    const { view, project } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('front', false, 0);
    const pivot = v3(500, -300, 200);
    orbit.beginOrbit(pivot);
    orbit.pan(30, 20);
    orbit.orbit(10, 0, v3(0, 0, 0));
    const pivotPx = project(pivot);
    expect(pivotPx).not.toBeNull();
    expect(orbit.endOrbit(true, 5000)).toBe('front');
    expect(orbit.transitioning).toBe(true);
    orbit.update(5180);
    expect(orbit.transitioning).toBe(false);
    expect(directionOf(orbit).y).toBeCloseTo(-1, 9);
    expect(orbit.basis().up.z).toBeCloseTo(1, 9);
    const settledPx = project(pivot);
    expect(settledPx!.x).toBeCloseTo(pivotPx!.x, 6);
    expect(settledPx!.y).toBeCloseTo(pivotPx!.y, 6);

    orbit.beginOrbit(pivot);
    orbit.orbit(20, 0, pivot);
    expect(orbit.endOrbit(true, 6000)).toBeNull();
    expect(orbit.transitioning).toBe(false);

    orbit.beginOrbit(pivot);
    orbit.orbit(10, 0, pivot);
    expect(orbit.endOrbit(false, 7000)).toBeNull();
    expect(orbit.transitioning).toBe(false);
  });

  it('preserves a deliberate roll at exact Top instead of snapping on release', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('top', false, 0);
    const pivot = v3(0, 0, 0);
    orbit.beginOrbit(pivot);
    orbit.orbit(60, 0, pivot);
    const rolled = view.perspective.quaternion.clone();
    expect(orbit.endOrbit()).toBeNull();
    expect(orbit.transitioning).toBe(false);
    expect(view.perspective.quaternion.equals(rolled)).toBe(true);
    expect(directionOf(orbit).z).toBeCloseTo(1, 12);
    expect(orbit.basis().up.angleTo(new THREE.Vector3(0, 1, 0))).toBeCloseTo(60 * 0.006, 2);
  });

  it('settles a small roll at Top within the snap angle', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('top', false, 0);
    const pivot = v3(0, 0, 0);
    orbit.beginOrbit(pivot);
    orbit.orbit(10, 0, pivot);
    expect(orbit.endOrbit(true, 5000)).toBe('top');
    orbit.update(5180);
    expect(orbit.transitioning).toBe(false);
    expect(directionOf(orbit).z).toBeCloseTo(1, 12);
    expect(orbit.basis().up.y).toBeCloseTo(1, 9);
    expect(Math.abs(orbit.basis().up.z)).toBeLessThan(1e-9);
  });

  it('does not snap a cancelled mid-transition roll just because the direction matches', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('top', false, 0);
    const pivot = v3(0, 0, 0);
    orbit.beginOrbit(pivot);
    orbit.orbit(60, 0, pivot);
    expect(orbit.endOrbit()).toBeNull();
    orbit.setView('top', true, 1000);
    orbit.update(1090);
    orbit.cancelTransition(false);
    orbit.beginOrbit(pivot);
    orbit.orbit(4, 0, pivot);
    expect(orbit.endOrbit()).toBeNull();
    expect(orbit.transitioning).toBe(false);
    expect(directionOf(orbit).z).toBeCloseTo(1, 12);
  });
});

describe('zoom anchoring', () => {
  it.each([false, true])('keeps an object anchor on the same pixel (ortho=%s)', (ortho) => {
    const { view, project } = makeViewport();
    view.ortho = ortho;
    const orbit = new OrbitController(view);
    orbit.setView('iso', false, 0);
    const anchor = v3(300, -200, 120);
    const px = project(anchor);
    expect(px).not.toBeNull();
    const distance = orbit.distance;
    orbit.zoom(1.4, px!, anchor);
    const after = project(anchor);
    expect(after).not.toBeNull();
    expect(after!.x).toBeCloseTo(px!.x, 5);
    expect(after!.y).toBeCloseTo(px!.y, 5);
    expect(orbit.distance).toBeCloseTo(distance / 1.4, 6);
  });

  it('anchors to the target plane when no object anchor is given', () => {
    const { view, project } = makeViewport();
    const orbit = new OrbitController(view);
    const px = project(orbit.target);
    expect(px).not.toBeNull();
    const distance = orbit.distance;
    orbit.zoom(1.25, px!);
    const after = project(orbit.target);
    expect(after!.x).toBeCloseTo(px!.x, 5);
    expect(after!.y).toBeCloseTo(px!.y, 5);
    expect(orbit.distance).toBeCloseTo(distance / 1.25, 6);
  });

  it('ignores neutral or invalid factors and clamps the distance', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    const position = orbit.position.clone();
    const target = orbit.target.clone();
    for (const factor of [0, Number.NaN, 1, -3, Number.POSITIVE_INFINITY]) orbit.zoom(factor);
    expect(orbit.position.equals(position)).toBe(true);
    expect(orbit.target.equals(target)).toBe(true);
    orbit.zoom(1e12);
    expect(orbit.distance).toBeCloseTo(20, 6);
    orbit.zoom(1e-12);
    expect(orbit.distance).toBeCloseTo(5e6, 0);
  });

  it('still zooms without a usable anchor intersection', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.setView('front', false, 0);
    const back = directionOf(orbit);
    const behind = v3(
      orbit.position.x + back.x * 100,
      orbit.position.y + back.y * 100,
      orbit.position.z + back.z * 100,
    );
    const distance = orbit.distance;
    orbit.zoom(1.5, v2(400, 300), behind);
    expect(orbit.distance).toBeCloseTo(distance / 1.5, 6);
    expect(Number.isFinite(orbit.position.x + orbit.position.y + orbit.position.z)).toBe(true);
    expect(Number.isFinite(orbit.target.x + orbit.target.y + orbit.target.z)).toBe(true);
  });
});

describe('fit', () => {
  it.each([false, true])('frames all box corners with padding in both window shapes (ortho=%s)', (ortho) => {
    for (const [width, height] of [[300, 1000], [1000, 400]] as const) {
      const { view, project } = makeViewport(width, height);
      view.ortho = ortho;
      const orbit = new OrbitController(view);
      const box = { min: v3(-1000, -500, -300), max: v3(2000, 1500, 800) };
      orbit.fit(box);
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const px = project(v3(x, y, z));
            expect(px).not.toBeNull();
            expect(px!.x).toBeGreaterThan(width * 0.05);
            expect(px!.x).toBeLessThan(width * 0.95);
            expect(px!.y).toBeGreaterThan(height * 0.05);
            expect(px!.y).toBeLessThan(height * 0.95);
          }
        }
      }
      expect(orbit.target.x).toBeCloseTo(500, 9);
      expect(orbit.target.y).toBeCloseTo(500, 9);
      expect(orbit.target.z).toBeCloseTo(250, 9);
    }
  });

  it('keeps the default framing for an empty scene', () => {
    const { view } = makeViewport();
    const orbit = new OrbitController(view);
    orbit.fit(null);
    expect(Number.isFinite(orbit.distance)).toBe(true);
    expect(orbit.distance).toBeGreaterThan(0);
  });
});
