import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeRect, Sketch } from '../model/sketch';
import { v3, type Vec3 } from '../model/vec';
import { OrbitController } from './orbit';
import { CAMERA_FOV_DEG, type Viewport } from './viewport';

function createOrbit(ortho = false): { orbit: OrbitController; viewport: Viewport } {
  const viewport = {
    width: 1200,
    height: 900,
    aspect: 4 / 3,
    ortho,
    perspective: new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 4 / 3, 1, 1e6),
    orthographic: new THREE.OrthographicCamera(),
    onResize: () => () => {},
  } as unknown as Viewport;
  return { orbit: new OrbitController(viewport), viewport };
}

function elevation(orbit: OrbitController): number {
  const direction = orbit.position.clone().sub(orbit.target).normalize();
  return Math.asin(THREE.MathUtils.clamp(direction.z, -1, 1));
}

function project(viewport: Viewport, point: Vec3): THREE.Vector3 {
  const camera = viewport.ortho ? viewport.orthographic : viewport.perspective;
  camera.updateMatrixWorld();
  return new THREE.Vector3(point.x, point.y, point.z).project(camera);
}

describe('orbit controller', () => {
  it.each([false, true])('keeps orbiting after pan, top view and a new shape (ortho=%s)', (ortho) => {
    const { orbit, viewport } = createOrbit(ortho);
    orbit.fit(null);
    orbit.pan(90, 60);
    orbit.setView('top');
    const sketch = new Sketch();
    sketch.addEntity({ type: 'rect', corners: makeRect(v3(1000, 500, 0), v3(1, 0, 0), v3(0, 1, 0), 2700, 2100) });
    const pivot = sketch.center();
    const geometry = sketch.serialize();
    const screen = project(viewport, pivot);
    const distance = orbit.distance;
    const right = orbit.basis().right;

    for (let step = 1; step <= 10; step++) {
      orbit.orbit(0, -5, pivot);
      expect(elevation(orbit)).toBeCloseTo(Math.PI / 2 - step * 5 * orbit.options.rotateSpeed, 9);
      expect(orbit.basis().right.dot(right)).toBeCloseTo(1, 9);
      expect(project(viewport, pivot).distanceTo(screen)).toBeLessThan(1e-9);
      expect(orbit.distance).toBeCloseTo(distance, 6);
      for (const camera of [viewport.perspective, viewport.orthographic]) {
        expect(camera.position.distanceTo(orbit.position)).toBeLessThan(1e-9);
        expect(camera.getWorldDirection(new THREE.Vector3()).distanceTo(orbit.basis().forward)).toBeLessThan(1e-9);
      }
    }

    const beforePan = project(viewport, pivot);
    const forward = orbit.basis().forward;
    orbit.pan(40, -25);
    const afterPan = project(viewport, pivot);
    expect(afterPan.x).toBeGreaterThan(beforePan.x);
    expect(afterPan.y).toBeGreaterThan(beforePan.y);
    expect(orbit.basis().forward.distanceTo(forward)).toBeLessThan(1e-9);
    expect(sketch.serialize()).toBe(geometry);
  });

  it.each([-1, 1])('clamps repeated vertical drags at pole %s and immediately allows reversing', (sign) => {
    const { orbit } = createOrbit();
    orbit.setView('front');
    const limit = THREE.MathUtils.degToRad(orbit.options.maxElevationDeg);
    const right = orbit.basis().right;
    for (let step = 0; step < 4; step++) {
      orbit.orbit(0, sign * 1000, v3(250, -100, 75));
      expect(elevation(orbit)).toBeCloseTo(sign * limit, 9);
      expect(orbit.basis().right.dot(right)).toBeCloseTo(1, 9);
    }
    orbit.orbit(0, -sign * 10, v3(250, -100, 75));
    expect(elevation(orbit)).toBeCloseTo(sign * (limit - 10 * orbit.options.rotateSpeed), 9);
  });

  it.each([-10, 10])('preserves ordinary drag direction for dy=%s', (dy) => {
    const { orbit } = createOrbit();
    const before = elevation(orbit);
    orbit.orbit(0, dy, v3(0, 0, 0));
    expect(elevation(orbit)).toBeCloseTo(before + dy * orbit.options.rotateSpeed, 9);
  });

  it('leaves the top pole without flipping during a horizontal drag', () => {
    const { orbit } = createOrbit();
    orbit.setView('top');
    const right = orbit.basis().right;
    orbit.orbit(10, 0, v3(1000, 500, 0));
    const expectedRight = right.applyAxisAngle(new THREE.Vector3(0, 0, 1), -10 * orbit.options.rotateSpeed);
    expect(orbit.basis().right.distanceTo(expectedRight)).toBeLessThan(1e-9);
    const limit = THREE.MathUtils.degToRad(orbit.options.maxElevationDeg);
    expect(elevation(orbit)).toBeCloseTo(limit, 9);
    orbit.orbit(0, -5, v3(1000, 500, 0));
    expect(elevation(orbit)).toBeCloseTo(limit - 5 * orbit.options.rotateSpeed, 9);
  });

  it('does not disturb the exact top view for a stationary cursor', () => {
    const { orbit, viewport } = createOrbit();
    orbit.setView('top');
    const position = orbit.position.clone();
    const target = orbit.target.clone();
    const orientation = viewport.perspective.quaternion.clone();
    let changes = 0;
    orbit.onChange(() => { changes++; });
    orbit.orbit(0, 0, v3(1000, 500, 0));
    expect(orbit.position.equals(position)).toBe(true);
    expect(orbit.target.equals(target)).toBe(true);
    expect(viewport.perspective.quaternion.equals(orientation)).toBe(true);
    expect(elevation(orbit)).toBe(Math.PI / 2);
    expect(changes).toBe(0);
  });
});
