import { Sketch, type SketchJSON } from '../model/sketch';

export interface LoadedSketchFile {
  name: string;
  data: SketchJSON;
}

export const SKETCH_DOWNLOAD_NAME = 'aircad-sketch.aircad.json';
export const MAX_SKETCH_BYTES = 2 * 1024 * 1024;
export const MAX_SKETCH_ENTITIES = 2000;
export const MAX_PROFILE_CORNERS = 256;
export const MAX_STORED_POINTS = 10_000;

const ENTITY_TYPES = new Set(['line', 'rect', 'polygon', 'extrusion', 'triangle', 'prism', 'circle']);

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFinitePoint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function storedPoints(entity: Record<string, unknown>): number {
  if (entity.type === 'line') return 2;
  if (entity.type === 'circle') return 1;
  return Array.isArray(entity.corners) ? entity.corners.length : 0;
}

function validateEntityRecord(entity: unknown, index: number, seen: Set<string>): Record<string, unknown> {
  if (!isRecord(entity)) fail(`Entity ${index + 1} is not an object.`);
  if ('sourceIds' in entity) fail('Derived loop records cannot be opened; save the source lines instead.');
  if (typeof entity.type !== 'string' || !ENTITY_TYPES.has(entity.type)) {
    fail(`Entity ${index + 1} has an unsupported type.`);
  }
  if (typeof entity.id !== 'string' || entity.id.length === 0) {
    fail(`Entity ${index + 1} needs a nonempty string id.`);
  }
  if (seen.has(entity.id)) fail(`Duplicate entity id ${entity.id}.`);
  seen.add(entity.id);

  const corners = entity.corners;
  if ((entity.type === 'polygon' || entity.type === 'extrusion' || entity.type === 'rect' || entity.type === 'triangle' || entity.type === 'prism') && Array.isArray(corners) && corners.length > MAX_PROFILE_CORNERS) {
    fail(`Entity ${entity.id} has too many corners (max ${MAX_PROFILE_CORNERS}).`);
  }
  if (entity.type === 'line' && (!isFinitePoint(entity.a) || !isFinitePoint(entity.b))) {
    fail(`Entity ${entity.id} has non-finite coordinates.`);
  }
  if (entity.type === 'circle' && (!isFinitePoint(entity.center) || !isFinitePoint(entity.normal) || !Number.isFinite(entity.radius))) {
    fail(`Entity ${entity.id} has non-finite coordinates.`);
  }
  if (Array.isArray(corners)) {
    for (const point of corners) {
      if (!isFinitePoint(point)) fail(`Entity ${entity.id} has non-finite coordinates.`);
    }
  }
  if ((entity.type === 'extrusion' || entity.type === 'prism') && !Number.isFinite(entity.depth)) {
    fail(`Entity ${entity.id} has a non-finite depth.`);
  }
  return entity;
}

/** Parse and fully validate a sketch document without touching the live model. */
export function parseSketchFile(text: string): SketchJSON {
  if (utf8Bytes(text) > MAX_SKETCH_BYTES) fail(`Sketch file is larger than ${MAX_SKETCH_BYTES / (1024 * 1024)} MiB.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail('Sketch file is not valid JSON.');
  }
  if (!isRecord(parsed)) fail('Sketch file must be a JSON object.');
  if (parsed.version !== 1) fail('Sketch file version is not supported.');
  if (parsed.units !== 'mm') fail('Sketch file units must be millimetres.');
  if (!Array.isArray(parsed.entities)) fail('Sketch file is missing an entities array.');
  if (parsed.entities.length > MAX_SKETCH_ENTITIES) fail(`Sketch file has too many entities (max ${MAX_SKETCH_ENTITIES}).`);

  const seen = new Set<string>();
  let points = 0;
  for (let index = 0; index < parsed.entities.length; index++) {
    const entity = validateEntityRecord(parsed.entities[index], index, seen);
    points += storedPoints(entity);
    if (points > MAX_STORED_POINTS) fail(`Sketch file has too many stored points (max ${MAX_STORED_POINTS}).`);
  }

  try {
    const sketch = Sketch.fromJSON(parsed as unknown as SketchJSON);
    return sketch.toJSON();
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Sketch file failed geometry validation.');
  }
}

export function downloadSketchFile(data: SketchJSON): void {
  const text = JSON.stringify(data);
  parseSketchFile(text);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = SKETCH_DOWNLOAD_NAME;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function chooseSketchFile(): Promise<LoadedSketchFile | null> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json,.aircad.json';
  input.value = '';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: LoadedSketchFile | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      if (error) reject(error);
      else resolve(result);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      if (file.size > MAX_SKETCH_BYTES) {
        finish(null, new Error(`Sketch file is larger than ${MAX_SKETCH_BYTES / (1024 * 1024)} MiB.`));
        return;
      }
      void file.text().then((text) => {
        try {
          finish({ name: file.name, data: parseSketchFile(text) });
        } catch (error) {
          finish(null, error);
        }
      }, (error) => finish(null, error));
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
