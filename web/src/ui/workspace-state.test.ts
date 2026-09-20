import { describe, expect, it } from 'vitest';
import { makeRect, type Entity, type ExtrusionEntity, type LineEntity, type PolygonEntity, type PrismEntity, type RectEntity, type TriangleEntity } from '../model/sketch';
import { v3 } from '../model/vec';
import {
  clearAvailability,
  CIRCLE_READONLY,
  deleteAvailability,
  dimensionsAvailability,
  displayStyleAvailability,
  entityLabel,
  EMPTY_PRESENTATION,
  EMPTY_SAVE,
  fileAvailability,
  PRESENTATION_ACTIONS,
  PRESENTING_FIRST,
  pressAvailability,
  presentationAllows,
  pushPullAvailability,
  revealAvailability,
  undoRedoAvailability,
  viewAvailability,
  workPlaneAvailability,
  EXTRUSION_FIRST,
  SELECT_PROFILE,
  STROKE_FIRST,
} from './workspace-state';

const line: LineEntity = { id: 'e1', type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) };
const rect: RectEntity = {
  id: 'e2',
  type: 'rect',
  corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000),
};
const box: ExtrusionEntity = { id: 'e3', type: 'extrusion', corners: rect.corners, depth: 2500 };
const outline: PolygonEntity = { id: 'e4', type: 'polygon', corners: [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)] };
const circle: Entity = { id: 'e5', type: 'circle', center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: 50 };
const triangle: TriangleEntity = { id: 'e6', type: 'triangle', corners: [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)] };
const prism: PrismEntity = { id: 'e7', type: 'prism', corners: triangle.corners, depth: 200 };

const idle = { drawing: false, extruding: false };
const drawing = { drawing: true, extruding: false };
const extruding = { drawing: false, extruding: true };
const base = { selected: null as Entity | null, canUndo: false, canRedo: false, entityCount: 0, presenting: false, sessionBlockReason: null as string | null };

describe('entityLabel', () => {
  it('labels entities with type and stable id', () => {
    expect(entityLabel(line)).toBe('Line e1');
    expect(entityLabel(rect)).toBe('Rectangle e2');
    expect(entityLabel(box)).toBe('Box e3');
    expect(entityLabel(outline)).toBe('Outline e4');
    expect(entityLabel(circle)).toBe('Circle e5');
    expect(entityLabel(triangle)).toBe('Triangle e6');
    expect(entityLabel(prism)).toBe('Prism e7');
  });
});

describe('command availability', () => {
  it('disables everything model-bound on an empty sketch', () => {
    expect(pushPullAvailability(null, idle).enabled).toBe(false);
    expect(dimensionsAvailability(null, idle).enabled).toBe(false);
    expect(deleteAvailability(null, idle).enabled).toBe(false);
    expect(clearAvailability({ ...idle, entityCount: 0 }).enabled).toBe(false);
    const { undo, redo } = undoRedoAvailability({ ...idle, canUndo: false, canRedo: false });
    expect(undo.enabled).toBe(false);
    expect(redo.enabled).toBe(false);
    expect(workPlaneAvailability(idle).enabled).toBe(true);
    expect(viewAvailability(idle).enabled).toBe(true);
  });

  it('offers dimensions and delete but not Push/Pull for a line', () => {
    expect(dimensionsAvailability(line, idle).enabled).toBe(true);
    expect(deleteAvailability(line, idle).enabled).toBe(true);
    const pushPull = pushPullAvailability(line, idle);
    expect(pushPull.enabled).toBe(false);
    expect(pushPull.reason).toBe(SELECT_PROFILE);
  });

  it('offers Push/Pull for a polygon outline and refuses a saved circle', () => {
    expect(pushPullAvailability(outline, idle).enabled).toBe(true);
    expect(dimensionsAvailability(outline, idle).enabled).toBe(true);
    const circlePush = pushPullAvailability(circle, idle);
    expect(circlePush.enabled).toBe(false);
    expect(circlePush.reason).toBe(CIRCLE_READONLY);
    const circleSize = dimensionsAvailability(circle, idle);
    expect(circleSize.enabled).toBe(false);
    expect(circleSize.reason).toBe(CIRCLE_READONLY);
  });

  it('offers Push/Pull for a triangle but not typed dimensions', () => {
    expect(pushPullAvailability(triangle, idle).enabled).toBe(true);
    expect(pushPullAvailability(prism, idle).enabled).toBe(true);
    const triangleSize = dimensionsAvailability(triangle, idle);
    expect(triangleSize.enabled).toBe(false);
    expect(triangleSize.reason).toMatch(/Q to extrude/);
    expect(dimensionsAvailability(prism, idle).enabled).toBe(true);
  });

  it('offers dimensions, delete and Push/Pull for a rectangle and a box', () => {
    for (const entity of [rect, box]) {
      expect(pushPullAvailability(entity, idle).enabled).toBe(true);
      expect(dimensionsAvailability(entity, idle).enabled).toBe(true);
      expect(deleteAvailability(entity, idle).enabled).toBe(true);
    }
  });

  it('blocks model commands while drawing with a truthful reason', () => {
    for (const availability of [
      pushPullAvailability(rect, drawing),
      dimensionsAvailability(rect, drawing),
      deleteAvailability(rect, drawing),
      clearAvailability({ ...drawing, entityCount: 1 }),
      workPlaneAvailability(drawing),
      viewAvailability(drawing),
    ]) {
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toBe(STROKE_FIRST);
    }
    // Grid snap is allowed mid-stroke (G re-resolves the preview).
    expect(pressAvailability('toggleGrid', { ...base, ...drawing, selected: rect, entityCount: 1 }).enabled).toBe(true);
  });

  it('blocks edits and plane changes but not view moves while extruding', () => {
    for (const availability of [
      pushPullAvailability(box, extruding),
      dimensionsAvailability(box, extruding),
      deleteAvailability(box, extruding),
      workPlaneAvailability(extruding),
      pressAvailability('toggleGrid', { ...base, ...extruding, selected: box, entityCount: 1 }),
    ]) {
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toBe(EXTRUSION_FIRST);
    }
    expect(viewAvailability(extruding).enabled).toBe(true);
  });
});

describe('pressAvailability', () => {
  const ctx = { ...base, ...idle, selected: rect, canUndo: true, entityCount: 1 };

  it('mirrors the per-command helpers', () => {
    expect(pressAvailability('undo', ctx).enabled).toBe(true);
    expect(pressAvailability('redo', ctx).enabled).toBe(false);
    expect(pressAvailability('delete', ctx).enabled).toBe(true);
    expect(pressAvailability('extrude', ctx).enabled).toBe(true);
    expect(pressAvailability('measure', ctx).enabled).toBe(true);
    expect(pressAvailability('viewTop', ctx).enabled).toBe(true);
    expect(pressAvailability('help', ctx).enabled).toBe(true);
  });

  it('rejects selection-dependent presses with no selection', () => {
    const empty = { ...ctx, selected: null };
    for (const action of ['measure', 'extrude', 'delete'] as const) {
      const result = pressAvailability(action, empty);
      expect(result.enabled).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});

describe('presentation guards', () => {
  const presenting = { ...base, ...idle, presenting: true, entityCount: 1 };

  it('keeps only the view allowlist live while presenting', () => {
    for (const action of ['reveal', 'cancel', 'viewTop', 'viewFront', 'viewRight', 'viewIso', 'toggleProjection', 'fitAll', 'zoomIn', 'zoomOut'] as const) {
      expect(presentationAllows(action)).toBe(true);
      expect(pressAvailability(action, presenting).enabled).toBe(true);
    }
    for (const action of ['select', 'move', 'scale', 'extrude', 'undo', 'redo', 'delete', 'clear', 'cyclePlane', 'toggleAutoPlane', 'toggleGrid', 'measure', 'voice', 'export', 'togglePip', 'help', 'setOrigin', 'recenter', 'confirm', 'saveSketch', 'openSketch'] as const) {
      expect(presentationAllows(action)).toBe(false);
      const result = pressAvailability(action, presenting);
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe(PRESENTING_FIRST);
    }
    expect(PRESENTATION_ACTIONS.size).toBe(10);
  });

  it('disables the display style select while presenting or in a session', () => {
    expect(displayStyleAvailability(presenting).reason).toBe(PRESENTING_FIRST);
    expect(displayStyleAvailability({ presenting: false, sessionBlockReason: STROKE_FIRST }).reason).toBe(STROKE_FIRST);
    expect(displayStyleAvailability({ presenting: false, sessionBlockReason: null }).enabled).toBe(true);
  });

  it('reveal requires an idle, nonempty sketch and exits while presenting', () => {
    expect(revealAvailability({ presenting: false, sessionBlockReason: null, entityCount: 0 }).reason).toBe(EMPTY_PRESENTATION);
    expect(revealAvailability({ presenting: false, sessionBlockReason: STROKE_FIRST, entityCount: 1 }).reason).toBe(STROKE_FIRST);
    expect(revealAvailability({ presenting: false, sessionBlockReason: null, entityCount: 1 }).enabled).toBe(true);
    expect(revealAvailability({ presenting: true, sessionBlockReason: null, entityCount: 1 }).enabled).toBe(true);
    // A blocked session also stops reveal through the shared press predicate.
    const blocked = pressAvailability('reveal', { ...base, ...drawing, sessionBlockReason: STROKE_FIRST });
    expect(blocked.enabled).toBe(false);
    expect(blocked.reason).toBe(STROKE_FIRST);
  });
});

describe('file availability', () => {
  it('requires an idle nonempty sketch to save and idle editing to open', () => {
    expect(fileAvailability({ presenting: false, sessionBlockReason: null, entityCount: 0 }, 'save').reason).toBe(EMPTY_SAVE);
    expect(fileAvailability({ presenting: false, sessionBlockReason: null, entityCount: 0 }, 'open').enabled).toBe(true);
    expect(fileAvailability({ presenting: false, sessionBlockReason: STROKE_FIRST, entityCount: 1 }, 'save').reason).toBe(STROKE_FIRST);
    expect(fileAvailability({ presenting: true, sessionBlockReason: null, entityCount: 1 }, 'open').reason).toBe(PRESENTING_FIRST);
    expect(pressAvailability('saveSketch', { ...base, ...idle, entityCount: 1 }).enabled).toBe(true);
    expect(pressAvailability('openSketch', { ...base, ...idle, entityCount: 0 }).enabled).toBe(true);
  });
});
