import { describe, expect, it } from 'vitest';
import { makeRect, type Entity, type ExtrusionEntity, type LineEntity, type RectEntity } from '../model/sketch';
import { v3 } from '../model/vec';
import {
  clearAvailability,
  deleteAvailability,
  dimensionsAvailability,
  entityLabel,
  pressAvailability,
  pushPullAvailability,
  undoRedoAvailability,
  viewAvailability,
  workPlaneAvailability,
  EXTRUSION_FIRST,
  STROKE_FIRST,
} from './workspace-state';

const line: LineEntity = { id: 'e1', type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) };
const rect: RectEntity = {
  id: 'e2',
  type: 'rect',
  corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000),
};
const box: ExtrusionEntity = { id: 'e3', type: 'extrusion', corners: rect.corners, depth: 2500 };

const idle = { drawing: false, extruding: false };
const drawing = { drawing: true, extruding: false };
const extruding = { drawing: false, extruding: true };
const base = { selected: null as Entity | null, canUndo: false, canRedo: false, entityCount: 0 };

describe('entityLabel', () => {
  it('labels entities with type and stable id', () => {
    expect(entityLabel(line)).toBe('Line e1');
    expect(entityLabel(rect)).toBe('Rectangle e2');
    expect(entityLabel(box)).toBe('Box e3');
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
    expect(pushPull.reason).toBe('Select a rectangle or box.');
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
  const ctx = { ...idle, selected: rect, canUndo: true, canRedo: false, entityCount: 1 };

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
