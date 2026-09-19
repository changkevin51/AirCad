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

export interface HandsMessage {
  type: 'hands';
  v?: number;
  t: number;
  frame: { w: number; h: number };
  hands: TrackedHandMessage[];
  nav: NavMessage | null;
  drawing?: boolean;
}

export interface ThumbMessage {
  type: 'thumb';
  jpeg: string;
  w: number;
  h: number;
}

export type CameraState = 'starting' | 'ready' | 'error' | 'stopped' | 'disabled';

export interface StatusMessage {
  type: 'status';
  camera: CameraState;
  message: string;
}

export type TrackerMessage = HandsMessage | ThumbMessage | StatusMessage;
export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface TrackerClientHandlers {
  onHands?(message: HandsMessage): void;
  onThumb?(message: ThumbMessage): void;
  onStatus?(message: StatusMessage): void;
  onConnection?(state: ConnectionState): void;
}

export function defaultTrackerUrl(loc: { protocol: string; host: string } = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/ws`;
}

export function parseTrackerMessage(text: string): TrackerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const message = data as { type?: unknown };
  if (message.type === 'hands' || message.type === 'thumb' || message.type === 'status') return message as TrackerMessage;
  return null;
}

export class TrackerClient {
  private socket: WebSocket | null = null;
  private retryDelayMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  state: ConnectionState = 'closed';
  lastStatus: StatusMessage | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: TrackerClientHandlers,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onConnection?.(state);
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
      const message = parseTrackerMessage(event.data);
      if (!message) return;
      if (message.type === 'hands') this.handlers.onHands?.(message);
      else if (message.type === 'thumb') this.handlers.onThumb?.(message);
      else {
        this.lastStatus = message;
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
