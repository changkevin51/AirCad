import { type CommandResult, type Commands } from '../model/commands';
import { type ExtrusionSession, type FacePullMeasurement } from '../model/extrusion';
import { profileFaces, pushPull, type ProfileFace } from '../model/faces';
import { PLANES } from '../model/plane';
import { isExtrudableProfile, rectFrame, type ProfileEntity } from '../model/sketch';
import { type LineMeasurement, type StrokeSession } from '../model/stroke';
import { add, distance, dot, isFinite3, length, nearlyEqual, scale, type Vec3 } from '../model/vec';

export const MAX_DIMENSION_MM = 1_000_000;
export const MIN_DIMENSION_MM = 1e-6;
const GEOMETRY_TOLERANCE_MM = 1e-6;

export interface VoiceCommand {
  distance_mm: number;
}
export interface VoiceContext {
  operation: 'line' | 'face_pull';
  units: 'mm';
}
export type VoiceOperation =
  | { kind: 'line'; measurement: LineMeasurement }
  | { kind: 'face_pull'; measurement: FacePullMeasurement; profile: ProfileEntity };
export interface VoiceTarget {
  source: StrokeSession | ExtrusionSession;
  operation: VoiceOperation;
  signature: string;
  context: VoiceContext;
  description: string;
}

const invalidDistance = (): never => {
  throw new Error('Say one positive distance, such as 500 mm or by 1 m');
};

const validDistance = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > MIN_DIMENSION_MM && value <= MAX_DIMENSION_MM;

export function parseVoiceCommand(value: unknown): VoiceCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidDistance();
  const command = value as Record<string, unknown>;
  if (Object.keys(command).length !== 1 || !Object.hasOwn(command, 'distance_mm')) invalidDistance();
  if (!validDistance(command.distance_mm)) invalidDistance();
  return { distance_mm: command.distance_mm };
}

function validateProfile(profile: ProfileEntity): void {
  if (profile.type !== 'rect' && profile.type !== 'extrusion') throw new Error('The measured geometry is not supported');
  const frame = rectFrame(profile);
  const depth = profile.type === 'extrusion' ? Math.abs(profile.depth) : 0;
  if (!isExtrudableProfile(profile.corners) || !validDistance(frame.width) || !validDistance(frame.height)
    || (profile.type === 'extrusion' && !validDistance(depth))) {
    throw new Error('The measured geometry is not supported');
  }
}

function faceFor(base: ProfileEntity, axis: ProfileFace['axis'], sign: ProfileFace['sign']): ProfileFace | null {
  return profileFaces(base).find((face) => face.axis === axis && face.sign === sign) ?? null;
}

function validateLineMeasurement(measurement: LineMeasurement): void {
  const plane = PLANES[measurement.plane];
  if (!plane || !isFinite3(measurement.start) || !isFinite3(measurement.direction)
    || !Number.isFinite(measurement.previewLength)
    || Math.abs(dot(measurement.direction, plane.normal)) > 1e-9
    || Math.abs(length(measurement.direction) - 1) > 1e-9) {
    throw new Error('The measured line direction is not supported');
  }
}

function validateFaceMeasurement(measurement: FacePullMeasurement): ProfileFace {
  if (measurement.direction !== 1 && measurement.direction !== -1) throw new Error('The measured pull direction is not supported');
  validateProfile(measurement.base);
  const face = faceFor(measurement.base, measurement.axis, measurement.sign);
  if (!face) throw new Error('The measured face is no longer available');
  return face;
}

export function captureVoiceTarget(stroke: StrokeSession | null, extrusion: ExtrusionSession | null, ready: boolean): VoiceTarget {
  if (!ready) throw new Error('Finish the current operation before using voice');
  if (stroke) {
    const measurement = stroke.measurement;
    if (!measurement) throw new Error('Move at least a short distance in one direction before using voice');
    validateLineMeasurement(measurement);
    const info = PLANES[measurement.plane];
    const degrees = (Math.atan2(dot(measurement.direction, info.v), dot(measurement.direction, info.u)) * 180) / Math.PI;
    const operation: VoiceOperation = { kind: 'line', measurement };
    return {
      source: stroke,
      operation,
      signature: JSON.stringify(operation),
      context: { operation: 'line', units: 'mm' },
      description: `Line · ${measurement.plane} · ${degrees.toFixed(1)}°`,
    };
  }
  if (extrusion) {
    const measurement = extrusion.measurement;
    if (!measurement) throw new Error('Pull the face at least a short distance before using voice');
    const face = validateFaceMeasurement(measurement);
    validateProfile(extrusion.profile);
    const operation: VoiceOperation = { kind: 'face_pull', measurement, profile: structuredClone(extrusion.profile) };
    return {
      source: extrusion,
      operation,
      signature: JSON.stringify(operation),
      context: { operation: 'face_pull', units: 'mm' },
      description: `${face.label} face · ${measurement.direction > 0 ? 'outward' : 'inward'}`,
    };
  }
  throw new Error('Start a line or pull a face before using voice');
}

export function sameVoiceTarget(a: VoiceTarget, b: VoiceTarget): boolean {
  return a.source === b.source && a.signature === b.signature
    && JSON.stringify(a.operation) === a.signature && JSON.stringify(b.operation) === b.signature;
}

function dispatchLine(command: VoiceCommand, measurement: LineMeasurement, commands: Commands, beforeCommit: () => void): CommandResult {
  validateLineMeasurement(measurement);
  const a = measurement.start;
  const b = add(a, scale(measurement.direction, command.distance_mm));
  if (!isFinite3(b) || Math.abs(distance(a, b) - command.distance_mm) > GEOMETRY_TOLERANCE_MM) {
    throw new Error('The measured direction cannot represent that distance');
  }
  beforeCommit();
  const result = commands.addLine({ ...a }, { ...b });
  if (!result.ok) return result;
  return { ...result, message: `Created ${command.distance_mm} mm line on ${measurement.plane}` };
}

function dispatchFacePull(command: VoiceCommand, operation: Extract<VoiceOperation, { kind: 'face_pull' }>, commands: Commands, beforeCommit: () => void): CommandResult {
  const measurement = operation.measurement;
  const face = validateFaceMeasurement(measurement);
  validateProfile(operation.profile);
  const signed = measurement.direction * command.distance_mm;
  const base = measurement.base;
  const frame = rectFrame(base);
  const baseDepth = base.type === 'extrusion' ? base.depth : 0;
  const solid = base.type === 'extrusion' && Math.abs(baseDepth) > 1e-9;
  if (solid || measurement.axis !== 'n') {
    const oldSize = measurement.axis === 'u' ? frame.width : measurement.axis === 'v' ? frame.height : Math.abs(baseDepth);
    if (!validDistance(oldSize + signed)) throw new Error('That distance would collapse, invert or exceed a size limit');
  }
  const pulled = pushPull(base, face, signed, 0);
  const resultFrame = rectFrame({ id: base.id, type: 'rect', corners: pulled.corners });
  if (!isExtrudableProfile(pulled.corners) || !Number.isFinite(pulled.depth)
    || !validDistance(resultFrame.width) || !validDistance(resultFrame.height)
    || !(Math.abs(pulled.depth) > MIN_DIMENSION_MM && Math.abs(pulled.depth) <= MAX_DIMENSION_MM)) {
    throw new Error('That distance would collapse, invert or exceed a size limit');
  }
  if (solid) {
    if (Math.sign(pulled.depth) !== Math.sign(baseDepth)) throw new Error('That distance would invert the solid');
    const candidate: ProfileEntity = { id: base.id, type: 'extrusion', corners: pulled.corners, depth: pulled.depth };
    const next = profileFaces(candidate);
    const moved = next.find((candidateFace) => candidateFace.axis === measurement.axis && candidateFace.sign === measurement.sign);
    const opposite = next.find((candidateFace) => candidateFace.axis === measurement.axis && candidateFace.sign === -measurement.sign);
    const oldOpposite = faceFor(base, measurement.axis, -measurement.sign as ProfileFace['sign']);
    if (!moved || !opposite || !oldOpposite
      || !nearlyEqual(moved.center, add(face.center, scale(face.normal, signed)), GEOMETRY_TOLERANCE_MM)
      || !nearlyEqual(opposite.center, oldOpposite.center, GEOMETRY_TOLERANCE_MM)
      || (measurement.axis !== 'u' && Math.abs(resultFrame.width - frame.width) > GEOMETRY_TOLERANCE_MM)
      || (measurement.axis !== 'v' && Math.abs(resultFrame.height - frame.height) > GEOMETRY_TOLERANCE_MM)
      || (measurement.axis !== 'n' && Math.abs(Math.abs(pulled.depth) - Math.abs(baseDepth)) > GEOMETRY_TOLERANCE_MM)) {
      throw new Error('The measured pull cannot be represented without changing other geometry');
    }
  } else if (Math.abs(Math.abs(pulled.depth) - command.distance_mm) > GEOMETRY_TOLERANCE_MM) {
    throw new Error('The measured pull cannot be represented without changing other geometry');
  }
  beforeCommit();
  const result = commands.extrude(operation.profile.id, pulled.depth, pulled.corners);
  if (!result.ok) return result;
  return { ...result, message: `${face.label} face moved ${command.distance_mm} mm ${measurement.direction > 0 ? 'outward' : 'inward'}` };
}

export function dispatchVoiceCommand(value: unknown, target: VoiceTarget, commands: Commands, current: VoiceTarget | null, beforeCommit: () => void = () => {}): CommandResult {
  try {
    const command = parseVoiceCommand(value);
    if (!current || !sameVoiceTarget(current, target)) throw new Error('Operation or geometry changed; record the command again');
    if (target.operation.kind === 'line') return dispatchLine(command, target.operation.measurement, commands, beforeCommit);
    return dispatchFacePull(command, target.operation, commands, beforeCommit);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid voice command' };
  }
}
