/**
 * The single source of truth for "pen buttons as keys".
 *
 * Hold actions behave like pen buttons: active while the key is down.
 * Press actions fire once on keydown.  Everything the HUD, the help overlay
 * and the key bar display is derived from these tables.
 */

export type HoldAction = 'draw' | 'orbit' | 'pan' | 'lockX' | 'lockY' | 'lockZ';

export type PressAction =
  | 'viewTop'
  | 'viewFront'
  | 'viewRight'
  | 'viewIso'
  | 'toggleProjection'
  | 'fitAll'
  | 'cyclePlane'
  | 'toggleAutoPlane'
  | 'zoomIn'
  | 'zoomOut'
  | 'undo'
  | 'redo'
  | 'delete'
  | 'cancel'
  | 'clear'
  | 'toggleGrid'
  | 'measure'
  | 'select'
  | 'move'
  | 'scale'
  | 'extrude'
  | 'confirm'
  | 'voice'
  | 'export'
  | 'togglePip'
  | 'help'
  | 'setOrigin'
  | 'recenter'
  | 'reveal'
  | 'saveSketch'
  | 'openSketch';

export type BindingGroup = 'pen' | 'view' | 'plane' | 'edit' | 'tools';

export interface Modifiers {
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  primary?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface KeyBinding<A extends string> {
  action: A;
  /** `KeyboardEvent.code` values that trigger the action. */
  codes: readonly string[];
  mods?: Modifiers;
  /** Human-readable key label (Windows flavour; see `keyLabel`). */
  label: string;
  help: string;
  group: BindingGroup;
}

export const HOLD_BINDINGS: readonly KeyBinding<HoldAction>[] = [
  { action: 'draw', codes: ['Space'], label: 'Space', help: 'Pen button 1 - hold to draw, release to commit', group: 'pen' },
  { action: 'orbit', codes: ['ShiftLeft', 'ShiftRight'], label: 'Shift', help: 'Pen button 2 - hold and move to orbit', group: 'pen' },
  { action: 'pan', codes: ['ControlLeft', 'ControlRight'], label: 'Ctrl', help: 'Pen button 3 - hold and move to pan', group: 'pen' },
  { action: 'lockX', codes: ['KeyX'], label: 'X', help: 'Hold while drawing - lock to the X axis', group: 'pen' },
  { action: 'lockY', codes: ['KeyY'], mods: { primary: false, ctrl: false }, label: 'Y', help: 'Hold while drawing - lock to the Y axis', group: 'pen' },
  { action: 'lockZ', codes: ['KeyZ'], mods: { primary: false }, label: 'Z', help: 'Hold while drawing - lock to the Z axis', group: 'pen' },
];

export const PRESS_BINDINGS: readonly KeyBinding<PressAction>[] = [
  { action: 'viewTop', codes: ['Digit1', 'Numpad1'], label: '1', help: 'Top view + XY plane (pins the plane)', group: 'view' },
  { action: 'viewFront', codes: ['Digit2', 'Numpad2'], label: '2', help: 'Front view + XZ plane (pins the plane)', group: 'view' },
  { action: 'viewRight', codes: ['Digit3', 'Numpad3'], label: '3', help: 'Right view + YZ plane (pins the plane)', group: 'view' },
  { action: 'viewIso', codes: ['Digit0', 'Numpad0'], label: '0', help: 'Isometric view', group: 'view' },
  { action: 'toggleProjection', codes: ['Digit5', 'Numpad5'], label: '5', help: 'Orthographic / perspective', group: 'view' },
  { action: 'fitAll', codes: ['KeyF'], label: 'F', help: 'Fit the sketch in view', group: 'view' },
  { action: 'reveal', codes: ['KeyD'], mods: { primary: false, ctrl: false, alt: false, shift: false }, label: 'D', help: 'Reveal the model / return to editing', group: 'view' },
  { action: 'zoomIn', codes: ['Equal', 'NumpadAdd'], label: '=', help: 'Zoom in (or mouse wheel)', group: 'view' },
  { action: 'zoomOut', codes: ['Minus', 'NumpadSubtract'], label: '-', help: 'Zoom out (or mouse wheel)', group: 'view' },
  { action: 'cyclePlane', codes: ['Tab'], label: 'Tab', help: 'Cycle work plane XY -> XZ -> YZ (pins; A returns to auto; while extruding: switch face)', group: 'plane' },
  { action: 'toggleAutoPlane', codes: ['KeyA'], label: 'A', help: 'Automatic / manual work plane', group: 'plane' },
  { action: 'toggleGrid', codes: ['KeyG'], label: 'G', help: 'Grid snap on / off', group: 'plane' },
  { action: 'undo', codes: ['KeyZ'], mods: { primary: true, shift: false }, label: 'Ctrl+Z', help: 'Undo', group: 'edit' },
  { action: 'redo', codes: ['KeyZ'], mods: { primary: true, shift: true }, label: 'Ctrl+Shift+Z', help: 'Redo', group: 'edit' },
  { action: 'redo', codes: ['KeyY'], mods: { ctrl: true }, label: 'Ctrl+Y', help: 'Redo', group: 'edit' },
  { action: 'delete', codes: ['Delete', 'Backspace'], mods: { primary: false }, label: 'Delete', help: 'Delete the selected, hovered, or last entity', group: 'edit' },
  { action: 'clear', codes: ['Backspace'], mods: { primary: true }, label: 'Ctrl+Backspace', help: 'Clear the whole sketch', group: 'edit' },
  { action: 'cancel', codes: ['Escape'], label: 'Esc', help: 'Cancel stroke, move, scale, or extrusion / deselect / close overlays', group: 'edit' },
  { action: 'select', codes: ['KeyS'], mods: { primary: false, ctrl: false, alt: false }, label: 'S', help: 'Select the shape under the cursor (or click)', group: 'edit' },
  { action: 'saveSketch', codes: ['KeyS'], mods: { primary: true, alt: false, shift: false }, label: 'Ctrl+S', help: 'Save the sketch as a local JSON download', group: 'edit' },
  { action: 'openSketch', codes: ['KeyO'], mods: { primary: true, alt: false, shift: false }, label: 'Ctrl+O', help: 'Open a local AirCAD JSON sketch', group: 'edit' },
  { action: 'move', codes: ['KeyM'], mods: { primary: false, ctrl: false, alt: false }, label: 'M', help: 'Move the selected shape: hold Space or drag, then Enter or M to apply; Esc cancels', group: 'tools' },
  { action: 'scale', codes: ['KeyR'], mods: { primary: false, ctrl: false, alt: false, shift: false }, label: 'R', help: 'Scale from a corner: hold Space or drag it; the opposite corner stays fixed. Enter / R applies; Esc cancels', group: 'tools' },
  { action: 'extrude', codes: ['KeyQ'], mods: { primary: false, ctrl: false, alt: false }, label: 'Q', help: 'Push/pull the selected closed outline or solid: pick a face, hold Space and move', group: 'tools' },
  { action: 'confirm', codes: ['Enter', 'NumpadEnter'], label: 'Enter', help: 'Apply the move, scale, or extrusion preview (M / R / Q also applies)', group: 'tools' },
  { action: 'measure', codes: ['KeyL'], label: 'L', help: 'Type a length, rectangle size, or extrusion depth', group: 'tools' },
  { action: 'voice', codes: ['KeyV'], mods: { primary: false, ctrl: false, alt: false }, label: 'V', help: 'Speak a distance for the active line or face pull; V confirms or sends it (recognizer picked in the voice panel)', group: 'tools' },
  { action: 'export', codes: ['KeyE'], label: 'E', help: 'Export to FreeCAD (legacy — needs the separate app)', group: 'tools' },
  { action: 'togglePip', codes: ['KeyP'], label: 'P', help: 'Camera picture-in-picture', group: 'tools' },
  { action: 'help', codes: ['KeyH', 'F1'], label: 'H', help: 'Help dialog', group: 'tools' },
  { action: 'setOrigin', codes: ['KeyO'], mods: { primary: false, ctrl: false, alt: false }, label: 'O', help: 'Set the depth-camera origin (depth mode)', group: 'tools' },
  { action: 'recenter', codes: ['KeyR'], mods: { primary: false, ctrl: false, alt: false, shift: true }, label: 'Shift+R', help: 'Recenter mapping on the last endpoint (depth mode)', group: 'tools' },
];

export type Platform = 'mac' | 'other';

export function detectPlatform(nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): Platform {
  const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad/i.test(text) ? 'mac' : 'other';
}

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

function modifiersMatch(event: KeyLike, mods: Modifiers | undefined, platform: Platform): boolean {
  if (!mods) return true;
  const primary = platform === 'mac' ? event.metaKey : event.ctrlKey;
  if (mods.primary !== undefined && mods.primary !== primary) return false;
  if (mods.ctrl !== undefined && mods.ctrl !== event.ctrlKey) return false;
  if (mods.meta !== undefined && mods.meta !== event.metaKey) return false;
  if (mods.shift !== undefined && mods.shift !== event.shiftKey) return false;
  if (mods.alt !== undefined && mods.alt !== event.altKey) return false;
  return true;
}

function specificity(binding: KeyBinding<string>): number {
  return binding.mods ? Object.keys(binding.mods).length : 0;
}

const PRESS_BY_SPECIFICITY = [...PRESS_BINDINGS].sort((a, b) => specificity(b) - specificity(a));

export function resolvePress(event: KeyLike, platform: Platform = detectPlatform()): PressAction | null {
  for (const binding of PRESS_BY_SPECIFICITY) {
    if (binding.codes.includes(event.code) && modifiersMatch(event, binding.mods, platform)) return binding.action;
  }
  return null;
}

export function resolveHold(event: KeyLike, platform: Platform = detectPlatform()): HoldAction | null {
  for (const binding of HOLD_BINDINGS) {
    if (binding.codes.includes(event.code) && modifiersMatch(event, binding.mods, platform)) return binding.action;
  }
  return null;
}

/** Which hold action a key code belongs to, regardless of modifiers (for key-up). */
export function holdActionForCode(code: string): HoldAction | null {
  return HOLD_BINDINGS.find((binding) => binding.codes.includes(code))?.action ?? null;
}

/** Platform-specific label: Ctrl+Z becomes Cmd+Z on macOS for primary-modifier bindings. */
export function keyLabel(binding: KeyBinding<string>, platform: Platform = detectPlatform()): string {
  if (platform === 'mac' && binding.mods?.primary) return binding.label.replace(/^Ctrl/, 'Cmd');
  return binding.label;
}

export function labelForAction(action: PressAction | HoldAction, platform: Platform = detectPlatform()): string {
  const binding =
    (PRESS_BINDINGS as readonly KeyBinding<string>[]).find((b) => b.action === action) ??
    (HOLD_BINDINGS as readonly KeyBinding<string>[]).find((b) => b.action === action);
  return binding ? keyLabel(binding, platform) : action;
}

export const GROUP_TITLES: Record<BindingGroup, string> = {
  pen: 'Pen buttons (hold)',
  view: 'Views & camera',
  plane: 'Work plane & snapping',
  edit: 'Editing',
  tools: 'Tools',
};

export const MOUSE_HELP: readonly { label: string; help: string }[] = [
  { label: 'Move', help: 'Drives the cursor when no keycap is tracked' },
  { label: 'Left drag', help: 'Draw (same as Space)' },
  { label: 'Left click', help: 'Select a shape; Q then left drag up/down to extrude' },
  { label: 'Right drag', help: 'Orbit (same as Shift)' },
  { label: 'Middle drag', help: 'Pan (same as Ctrl)' },
  { label: 'Wheel', help: 'Zoom toward the cursor (faster spin zooms faster)' },
];
