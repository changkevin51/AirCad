/** WebSocket client for the Python tracker (see tracker/protocol.py). */

export interface TrackedHandMessage {
  id: number;
  handedness: 'left' | 'right' | string | null;
  /** Index fingertip in mirrored camera pixels; optional third value is depth. */
  tip: [number, number] | [number, number, number];
  thumb: [number, number];
  palm: [number, number];
  palmSize: number;
  pinching: boolean;
  open: boolean;
  openArmed: boolean;
  landmarks: [number, number][];
}

export interface NavMessage {
  mode: 'one' | 'two';
  pan: [number, number];
  zoom: number;
  rotation: number;
}

export interface ManagedStream {
  streamId: string;
  sourceRunId: string | null;
  config?: TrackerConfigJson;
}

export interface HandsMessage {
  type: 'hands';
  v?: number;
  t: number;
  frame: { w: number; h: number };
  hands: TrackedHandMessage[];
  nav: NavMessage | null;
  drawing?: boolean;
  managed?: ManagedStream;
}

export interface ThumbMessage {
  type: 'thumb';
  jpeg: string;
  w: number;
  h: number;
  managed?: ManagedStream;
}

export type CameraState = 'starting' | 'ready' | 'error' | 'stopped' | 'disabled';

export interface StatusMessage {
  type: 'status';
  camera: CameraState;
  message: string;
  managed?: ManagedStream;
}

export type SpatialTarget = 'finger' | 'color';
export type SpatialState = 'acquiring' | 'tracked' | 'held' | 'lost';

export interface SpatialQuality {
  validPixels: number;
  roiCount: number;
  spreadMm: number | null;
  pairSkewMs: number | null;
}

export interface SpatialMessage {
  type: 'spatial';
  v: 2;
  streamId: string;
  sourceRunId: string;
  seq: number;
  t: number;
  sampleTimeMs: number | null;
  ageMs: number | null;
  target: SpatialTarget;
  trackingEpoch: number;
  frame: { w: number; h: number; mirrored: true };
  pixel: [number, number] | null;
  cameraMm: [number, number, number] | null;
  state: SpatialState;
  fresh: boolean;
  reason: string | null;
  quality: SpatialQuality;
}

export type TrackerSource = 'webcam' | 'oak' | 'none';
export type ColorPreset = 'green' | 'red' | 'blue';

export interface TrackerConfigJson {
  source: TrackerSource;
  cameraIndex: number;
  target: SpatialTarget;
  colorPreset: ColorPreset;
  colorTolerance: number;
}

export interface TrackerSnapshot {
  ok: true;
  config: TrackerConfigJson;
  camera: CameraState;
  message: string;
  streamId: string;
  sourceRunId: string | null;
  capabilities: {
    sources: TrackerSource[];
    depthTargets: SpatialTarget[];
    depthaiInstalled: boolean;
  };
  serverTimeMs: number;
}

export type TrackerMessage = HandsMessage | ThumbMessage | StatusMessage | SpatialMessage;
export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface TrackerClientHandlers {
  onHands?(message: HandsMessage): void;
  onThumb?(message: ThumbMessage): void;
  onStatus?(message: StatusMessage): void;
  onSpatial?(message: SpatialMessage): void;
  onConnection?(state: ConnectionState): void;
  onSessionReset?(streamId: string, sourceRunId: string | null): void;
  /** Every successful GET /api/tracker refresh, not just the first. */
  onSnapshot?(snapshot: TrackerSnapshot): void;
}

export const SPATIAL_VERSION = 2;
export const CLOCK_SYNC_INTERVAL_MS = 30_000;
const MAX_FRAME_DIM = 8192;

export function defaultTrackerUrl(loc: { protocol: string; host: string } = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/ws`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
};

const integer = (value: unknown, minimum = 0, maximum?: number): number | null => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < minimum || (maximum !== undefined && value > maximum)) return null;
  return value;
};

const nonemptyId = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function optionalMs(value: unknown): number | null | undefined {
  if (value === null) return null;
  const number = finiteNumber(value);
  if (number === null || number < 0) return undefined;
  return number;
}

function parseTuple2(value: unknown): [number, number] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const x = finiteNumber(value[0]);
  const y = finiteNumber(value[1]);
  if (x === null || y === null) return undefined;
  return [x, y];
}

function parseTuple3(value: unknown): [number, number, number] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const x = finiteNumber(value[0]);
  const y = finiteNumber(value[1]);
  const z = finiteNumber(value[2]);
  if (x === null || y === null || z === null) return undefined;
  return [x, y, z];
}

export interface SpatialParseState {
  streamId: string | null;
  lastSeq: number | null;
  lastT: number | null;
}

export function parseSpatialMessage(data: unknown, state?: SpatialParseState): SpatialMessage | null {
  if (!isObject(data) || data.type !== 'spatial') return null;
  if (data.v !== SPATIAL_VERSION) return null;
  const streamId = nonemptyId(data.streamId);
  const sourceRunId = nonemptyId(data.sourceRunId);
  const seq = integer(data.seq, 0);
  const t = finiteNumber(data.t);
  const sampleTime = optionalMs(data.sampleTimeMs);
  const age = optionalMs(data.ageMs);
  const target = data.target;
  const stateName = data.state;
  const epoch = integer(data.trackingEpoch, 0);
  if (!streamId || !sourceRunId || seq === null || t === null || t < 0 || epoch === null) return null;
  if (target !== 'finger' && target !== 'color') return null;
  if (stateName !== 'acquiring' && stateName !== 'tracked' && stateName !== 'held' && stateName !== 'lost') return null;
  if (typeof data.fresh !== 'boolean') return null;
  if (sampleTime === undefined || age === undefined) return null;
  if (sampleTime !== null && sampleTime - t > 0.1) return null;

  if (!isObject(data.frame)) return null;
  const width = integer(data.frame.w, 1, MAX_FRAME_DIM);
  const height = integer(data.frame.h, 1, MAX_FRAME_DIM);
  if (width === null || height === null || data.frame.mirrored !== true) return null;

  const pixel = parseTuple2(data.pixel);
  const cameraMm = parseTuple3(data.cameraMm);
  if (pixel === undefined || cameraMm === undefined) return null;
  if (pixel && (pixel[0] < 0 || pixel[0] > width - 1 || pixel[1] < 0 || pixel[1] > height - 1)) return null;

  if (stateName === 'tracked') {
    if (!data.fresh || cameraMm === null || sampleTime === null || age === null) return null;
  } else if (stateName === 'held') {
    if (data.fresh || cameraMm === null || sampleTime === null || age === null) return null;
  } else if (data.fresh || cameraMm !== null || sampleTime !== null || age !== null) {
    return null;
  }

  if (!isObject(data.quality)) return null;
  const validPixels = integer(data.quality.validPixels, 0);
  const roiCount = integer(data.quality.roiCount, 0);
  const spreadMm = optionalMs(data.quality.spreadMm);
  const pairSkewMs = optionalMs(data.quality.pairSkewMs);
  if (validPixels === null || roiCount === null || spreadMm === undefined || pairSkewMs === undefined) return null;

  if (state) {
    if (state.streamId === streamId) {
      if (state.lastSeq !== null && seq <= state.lastSeq) return null;
      if (state.lastT !== null && t < state.lastT) return null;
    }
    state.streamId = streamId;
    state.lastSeq = seq;
    state.lastT = t;
  }

  const reason = data.reason === null || data.reason === undefined ? null : String(data.reason);
  return {
    type: 'spatial',
    v: 2,
    streamId,
    sourceRunId,
    seq,
    t,
    sampleTimeMs: sampleTime,
    ageMs: age,
    target,
    trackingEpoch: epoch,
    frame: { w: width, h: height, mirrored: true },
    pixel,
    cameraMm,
    state: stateName,
    fresh: data.fresh,
    reason,
    quality: { validPixels, roiCount, spreadMm, pairSkewMs },
  };
}

export function parseTrackerMessage(text: string, spatialState?: SpatialParseState): TrackerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  if (data.type === 'spatial') return parseSpatialMessage(data, spatialState);
  if (data.type === 'hands' || data.type === 'thumb' || data.type === 'status') {
    return data as unknown as TrackerMessage;
  }
  return null;
}

/**
 * Conservative client/server monotonic clock offset from GET /api/tracker.
 *
 * For a GET started at client monotonic c0, completed at c1, and stamped with
 * server monotonic s, the offset (client - server) lies in [c0-s, c1-s]. The
 * lower bound yields an age upper bound: now - sampleTime - (c0-s).
 */
export class ClockSync {
  offsetLower: number | null = null;
  rttMs: number | null = null;
  lastSyncAt = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.offsetLower = null;
    this.rttMs = null;
    this.lastSyncAt = 0;
  }

  get synced(): boolean {
    return this.offsetLower !== null;
  }

  needsRefresh(now = this.now()): boolean {
    return !this.synced || now - this.lastSyncAt >= CLOCK_SYNC_INTERVAL_MS;
  }

  observe(c0: number, c1: number, serverTimeMs: number): void {
    if (!Number.isFinite(c0) || !Number.isFinite(c1) || !Number.isFinite(serverTimeMs) || c1 < c0) return;
    const rtt = c1 - c0;
    if (this.rttMs !== null && rtt > this.rttMs) return;
    this.rttMs = rtt;
    this.offsetLower = c0 - serverTimeMs;
    this.lastSyncAt = c1;
  }

  /**
   * Conservative upper bound of sample age, or null when clocks are unsynced.
   * Fail closed: drawing must wait rather than assume an old frame is fresh.
   */
  ageUpperBoundMs(
    sampleTimeMs: number,
    nowClient: number,
    ageMs: number | null = null,
    receivedAt: number | null = null,
  ): number | null {
    if (this.offsetLower === null) return null;
    const fromSync = nowClient - sampleTimeMs - this.offsetLower;
    const fromReceipt =
      ageMs !== null && receivedAt !== null ? ageMs + Math.max(0, nowClient - receivedAt) : -Infinity;
    return Math.max(fromSync, fromReceipt);
  }
}

export async function fetchTrackerSnapshot(now: () => number = () => performance.now()): Promise<{
  snapshot: TrackerSnapshot;
  c0: number;
  c1: number;
} | null> {
  const c0 = now();
  try {
    const response = await fetch('/api/tracker', { headers: { Accept: 'application/json' } });
    const c1 = now();
    if (!response.ok) return null;
    const payload = (await response.json()) as TrackerSnapshot;
    if (!payload || payload.ok !== true || typeof payload.serverTimeMs !== 'number') return null;
    return { snapshot: payload, c0, c1 };
  } catch {
    return null;
  }
}

export async function postTrackerConfig(body: {
  expectedStreamId: string;
  config?: TrackerConfigJson;
  retry?: boolean;
}): Promise<{ ok: true; snapshot: TrackerSnapshot } | { ok: false; status: number; error: string }> {
  try {
    const response = await fetch('/api/tracker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Partial<TrackerSnapshot>;
    if (response.ok && payload.ok) return { ok: true, snapshot: payload as TrackerSnapshot };
    return { ok: false, status: response.status, error: payload.error ?? response.statusText };
  } catch (error) {
    return { ok: false, status: 0, error: (error as Error).message };
  }
}

export class TrackerClient {
  private socket: WebSocket | null = null;
  private retryDelayMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly spatialState: SpatialParseState = { streamId: null, lastSeq: null, lastT: null };
  private lastStreamId: string | null = null;
  private lastSourceRunId: string | null = null;
  readonly clock = new ClockSync();
  state: ConnectionState = 'closed';
  lastStatus: StatusMessage | null = null;
  lastSnapshot: TrackerSnapshot | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: TrackerClientHandlers,
    private readonly now: () => number = () => performance.now(),
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  async syncClock(): Promise<boolean> {
    const result = await fetchTrackerSnapshot(this.now);
    if (!result) return false;
    this.lastSnapshot = result.snapshot;
    this.clock.observe(result.c0, result.c1, result.snapshot.serverTimeMs);
    this.noteSession(result.snapshot.streamId, result.snapshot.sourceRunId);
    this.handlers.onSnapshot?.(result.snapshot);
    return this.clock.synced;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onConnection?.(state);
    if (state === 'open') void this.syncClock().then(() => this.scheduleSync());
    if (state === 'closed' || state === 'connecting') this.clock.reset();
  }

  private scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.state === 'open') void this.syncClock().then(() => this.scheduleSync());
    }, CLOCK_SYNC_INTERVAL_MS);
  }

  private noteSession(streamId: string | null, sourceRunId: string | null): void {
    if (streamId === this.lastStreamId && sourceRunId === this.lastSourceRunId) return;
    const changed = this.lastStreamId !== null || this.lastSourceRunId !== null;
    this.lastStreamId = streamId;
    this.lastSourceRunId = sourceRunId;
    if (changed && streamId) this.handlers.onSessionReset?.(streamId, sourceRunId);
  }

  private open(): void {
    this.setState('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retryDelayMs = 500;
      this.setState('open');
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseTrackerMessage(event.data, this.spatialState);
      if (!message) return;
      if (message.type === 'hands') {
        if (message.managed) this.noteSession(message.managed.streamId, message.managed.sourceRunId);
        this.handlers.onHands?.(message);
      } else if (message.type === 'thumb') {
        if (message.managed) this.noteSession(message.managed.streamId, message.managed.sourceRunId);
        this.handlers.onThumb?.(message);
      } else if (message.type === 'spatial') {
        this.noteSession(message.streamId, message.sourceRunId);
        this.handlers.onSpatial?.(message);
      } else {
        this.lastStatus = message;
        if (message.managed) this.noteSession(message.managed.streamId, message.managed.sourceRunId);
        this.handlers.onStatus?.(message);
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.setState('closed');
      this.scheduleRetry();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleRetry(): void {
    if (this.closedByUser || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelayMs = Math.min(5000, this.retryDelayMs * 1.6);
      this.open();
    }, this.retryDelayMs);
  }
}
