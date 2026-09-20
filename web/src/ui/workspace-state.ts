import type { PressAction } from '../input/keymap';
import type { PlaneKind } from '../model/plane';
import { isExtrudableProfile, type Entity } from '../model/sketch';
import type { InspectorTab } from './workspace';

/** Typed boundary between chrome components and the App dispatcher. */
export type WorkspaceAction =
  | { type: 'press'; action: PressAction }
  | { type: 'selectEntity'; id: string | null }
  | { type: 'setWorkPlane'; plane: PlaneKind | 'auto' }
  | { type: 'setDimension'; id: string; spec: string }
  | { type: 'setExtrusionFace'; index: number }
  | { type: 'setExtrusionPull'; text: string };

export type UiActionResult = { ok: true } | { ok: false; error: string };

export interface CommandAvailability {
  enabled: boolean;
  reason?: string;
}

/** Live Push/Pull operation state for the inspector's operation section. */
export interface ExtrusionSnapshot {
  targetId: string;
  targetLabel: string;
  /** Faces of the current preview: 2 on a flat rect, 6 on a solid. */
  faces: { index: number; label: string }[];
  faceIndex: number;
  dragging: boolean;
  /** Signed pull of the active face from its base snapshot (mm). */
  pull: number;
  /** Resulting box depth (mm). */
  depth: number;
  baseWidth: number;
  baseHeight: number;
  /** The preview can be committed (non-zero depth, valid profile). */
  previewValid: boolean;
}

/** Snapshot of the model/session state the chrome needs to render itself. */
export interface UiSnapshot {
  drawing: boolean;
  extruding: boolean;
  entityCount: number;
  selected: Entity | null;
  canUndo: boolean;
  canRedo: boolean;
  planeKind: PlaneKind;
  planeMode: 'auto' | 'manual';
  gridEnabled: boolean;
  gridStep: number;
  ortho: boolean;
  inputLabel: string;
  pipVisible: boolean;
  navAssist: boolean;
  browserVisible: boolean;
  inspectorVisible: boolean;
  inspectorTab: InspectorTab;
  extrusion: ExtrusionSnapshot | null;
}

export interface AvailabilityContext {
  drawing: boolean;
  extruding: boolean;
}

export const STROKE_FIRST = 'Finish the current stroke first.';
export const EXTRUSION_FIRST = 'Finish or cancel Push/Pull first.';
export const SELECT_PROFILE = 'Select a rectangle or box.';
export const SELECT_OBJECT = 'Select an object first.';

/** Browser/inspector label: type word plus the entity's stable id. */
export function entityLabel(entity: Entity): string {
  const noun = entity.type === 'line' ? 'Line' : entity.type === 'rect' ? 'Rectangle' : 'Box';
  return `${noun} ${entity.id}`;
}

const blocked = (ctx: AvailabilityContext): CommandAvailability | null => {
  if (ctx.drawing) return { enabled: false, reason: STROKE_FIRST };
  if (ctx.extruding) return { enabled: false, reason: EXTRUSION_FIRST };
  return null;
};

export function pushPullAvailability(selected: Entity | null, ctx: AvailabilityContext): CommandAvailability {
  const guard = blocked(ctx);
  if (guard) return guard;
  if (!selected || selected.type === 'line') return { enabled: false, reason: SELECT_PROFILE };
  if (!isExtrudableProfile(selected.corners)) {
    return { enabled: false, reason: 'This shape is not a planar rectangle.' };
  }
  return { enabled: true };
}

export function dimensionsAvailability(selected: Entity | null, ctx: AvailabilityContext): CommandAvailability {
  const guard = blocked(ctx);
  if (guard) return guard;
  if (!selected) return { enabled: false, reason: SELECT_OBJECT };
  return { enabled: true };
}

export function deleteAvailability(selected: Entity | null, ctx: AvailabilityContext): CommandAvailability {
  const guard = blocked(ctx);
  if (guard) return guard;
  if (!selected) return { enabled: false, reason: SELECT_OBJECT };
  return { enabled: true };
}

export function undoRedoAvailability(ctx: AvailabilityContext & { canUndo: boolean; canRedo: boolean }): {
  undo: CommandAvailability;
  redo: CommandAvailability;
} {
  const guard = blocked(ctx);
  return {
    undo: guard ?? (ctx.canUndo ? { enabled: true } : { enabled: false, reason: 'Nothing to undo.' }),
    redo: guard ?? (ctx.canRedo ? { enabled: true } : { enabled: false, reason: 'Nothing to redo.' }),
  };
}

export function clearAvailability(ctx: AvailabilityContext & { entityCount: number }): CommandAvailability {
  const guard = blocked(ctx);
  if (guard) return guard;
  return ctx.entityCount > 0 ? { enabled: true } : { enabled: false, reason: 'Sketch is already empty.' };
}

export function workPlaneAvailability(ctx: AvailabilityContext): CommandAvailability {
  return blocked(ctx) ?? { enabled: true };
}

/** View presets / projection / fit are safe during extrusion but not mid-stroke. */
export function viewAvailability(ctx: AvailabilityContext): CommandAvailability {
  if (ctx.drawing) return { enabled: false, reason: STROKE_FIRST };
  return { enabled: true };
}

/**
 * The single availability predicate for a UI-originated press.  The
 * dispatcher applies the same check so there is no unguarded path; keyboard
 * shortcuts still go through `doPress` with their historical fallbacks.
 */
export function pressAvailability(
  action: PressAction,
  ctx: AvailabilityContext & { selected: Entity | null; canUndo: boolean; canRedo: boolean; entityCount: number },
): CommandAvailability {
  switch (action) {
    case 'undo':
      return undoRedoAvailability(ctx).undo;
    case 'redo':
      return undoRedoAvailability(ctx).redo;
    case 'delete':
      return deleteAvailability(ctx.selected, ctx);
    case 'clear':
      return clearAvailability(ctx);
    case 'extrude':
      return pushPullAvailability(ctx.selected, ctx);
    case 'measure':
      return dimensionsAvailability(ctx.selected, ctx);
    case 'viewTop':
    case 'viewFront':
    case 'viewRight':
    case 'viewIso':
    case 'toggleProjection':
    case 'fitAll':
    case 'zoomIn':
    case 'zoomOut':
    case 'cyclePlane':
    case 'toggleAutoPlane':
      return viewAvailability(ctx);
    case 'toggleGrid':
      // G during a stroke is a supported mid-stroke retoggle.
      return ctx.extruding ? { enabled: false, reason: EXTRUSION_FIRST } : { enabled: true };
    case 'export':
      return blocked(ctx) ?? { enabled: true };
    default:
      return { enabled: true };
  }
}
