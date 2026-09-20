import { regionRect } from '../input/cursor';
import { KeycapFilter } from '../input/keycap-filter';
import type { CameraState, KeycapMessage, SpatialMessage, ThumbMessage, TrackerSource } from '../input/tracker-client';
import { inputStatus } from './input-panel';

/** Camera picture-in-picture with the keycap center and the active mapping region. */
export class CameraPip {
  private readonly element: HTMLDivElement;
  private image = new Image();
  private readonly canvas = document.createElement('canvas');
  private readonly empty = document.createElement('div');
  private readonly caption = document.createElement('div');
  private keycaps: KeycapMessage | null = null;
  private spatial: SpatialMessage | null = null;
  private cursorKeycapId: number | null = null;
  private imageSize = { w: 192, h: 144 };
  private streamId: string | null = null;
  private hasFrame = false;
  private pairedPreview = false;
  private loadGeneration = 0;
  private readonly previewFilter = new KeycapFilter();
  private previewId: number | null = null;
  private source: TrackerSource = 'webcam';
  visible = true;

  constructor(root: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'pip pip--empty';
    this.canvas.className = 'pip__image';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Camera preview with keycap tracking');
    this.empty.className = 'pip__empty';
    this.caption.className = 'pip__caption';
    this.caption.textContent = 'Camera';
    this.element.append(this.canvas, this.empty, this.caption);
    root.appendChild(this.element);
  }

  setThumb(message: ThumbMessage): void {
    const generation = ++this.loadGeneration;
    const image = new Image();
    if (message.keycapFrame) this.pairedPreview = true;
    image.onload = () => {
      if (generation !== this.loadGeneration) return;
      this.image = image;
      this.imageSize = { w: message.w, h: message.h };
      this.element.style.setProperty('--pip-aspect', `${message.w} / ${message.h}`);
      if (message.keycapFrame) {
        const frame = message.keycapFrame;
        const target = frame.keycaps[0];
        if (!target || target.id !== this.previewId) this.previewFilter.reset();
        this.previewId = target?.id ?? null;
        // Separate display-space filtering for the preview, never applied to
        // the CAD cursor a second time. Image and dot are presented atomically.
        const scale = (this.element.clientWidth || message.w) / frame.frame.w;
        const point = target ? this.previewFilter.filter({ x: target.center[0] * scale, y: target.center[1] * scale }, frame.t / 1000) : null;
        this.keycaps = { ...frame, keycaps: target && point ? [{ ...target, center: [point.x / scale, point.y / scale] }] : [] };
        this.cursorKeycapId = target?.id ?? null;
        this.spatial = null;
      }
      this.hasFrame = true;
      this.element.classList.remove('pip--empty');
      this.draw();
    };
    image.src = `data:image/jpeg;base64,${message.jpeg}`;
  }

  setKeycap(message: KeycapMessage, cursorKeycapId: number | null): void {
    if (this.pairedPreview) return;
    this.keycaps = message;
    this.spatial = null;
    this.cursorKeycapId = cursorKeycapId;
    this.draw();
  }

  setSpatial(message: SpatialMessage | null): void {
    if (message && this.streamId && message.streamId !== this.streamId) this.spatial = null;
    this.spatial = message;
    if (message) this.streamId = message.streamId;
    this.keycaps = null;
    this.draw();
  }

  setStream(streamId: string | null): void {
    if (streamId !== this.streamId) {
      this.spatial = null;
      this.keycaps = null;
      this.resetPreview();
    }
    this.streamId = streamId;
  }

  /** Mouse source hides the whole slot; camera sources always show a state. */
  setSource(source: TrackerSource): void {
    if (source !== this.source) this.resetPreview();
    this.source = source;
    this.applyVisibility();
  }

  setCameraState(state: CameraState | null, connected: boolean, message?: string | null): void {
    if (state === 'disabled' || state === 'starting' || state === 'error' || state === null) {
      this.hasFrame = false;
      this.resetPreview();
    }
    this.element.classList.toggle('pip--empty', !this.hasFrame);
    if (!connected) this.caption.textContent = 'Tracker offline';
    else if (this.spatial && state === 'ready') {
      const health = this.spatial.fresh ? 'depth ok' : this.spatial.reason ?? this.spatial.state;
      this.caption.textContent = `Green keycap · ${health}`;
    } else {
      const status = inputStatus({
        connection: connected ? 'open' : 'closed',
        camera: state,
        cameraMessage: message ?? null,
        source: this.source === 'none' ? 'webcam' : this.source,
        spatialState: this.spatial?.state ?? null,
        spatialReason: this.spatial?.reason ?? null,
      });
      this.caption.textContent = status.text;
    }
    this.empty.textContent = this.caption.textContent;
    this.element.classList.toggle('pip--inactive', !connected || state !== 'ready');
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.applyVisibility();
    return this.visible;
  }

  private applyVisibility(): void {
    // In mouse mode the slot collapses entirely — never a black card.
    this.element.classList.toggle('hidden', !this.visible || this.source === 'none');
  }

  private resetPreview(): void {
    this.loadGeneration++;
    this.pairedPreview = false;
    this.previewId = null;
    this.previewFilter.reset();
  }

  private draw(): void {
    if (!this.visible) return;
    const { w, h } = this.imageSize;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, w, h);
    if (this.hasFrame) context.drawImage(this.image, 0, 0, w, h);
    const spatial = this.spatial;
    if (spatial) {
      const scaleX = w / spatial.frame.w;
      const scaleY = h / spatial.frame.h;
      if (spatial.pixel) {
        context.beginPath();
        context.arc(spatial.pixel[0] * scaleX, spatial.pixel[1] * scaleY, 5, 0, Math.PI * 2);
        context.fillStyle = spatial.fresh ? '#6fe3b4' : '#ffc857';
        context.fill();
      }
      return;
    }
    const keycaps = this.keycaps;
    if (!keycaps) return;
    if (this.hasFrame && this.source === 'webcam') this.caption.textContent = 'Green keycap';
    const scaleX = w / keycaps.frame.w;
    const scaleY = h / keycaps.frame.h;
    const region = regionRect(keycaps.frame);
    context.strokeStyle = 'rgba(111, 227, 180, 0.9)';
    context.lineWidth = 1.5;
    context.setLineDash([4, 3]);
    context.strokeRect(region.x * scaleX, region.y * scaleY, region.w * scaleX, region.h * scaleY);
    context.setLineDash([]);
    for (const keycap of keycaps.keycaps) {
      const isCursor = keycap.id === this.cursorKeycapId;
      const [x, y] = keycap.center;
      const radius = Math.max(6, Math.min(11, Math.min(w, h) * 0.06));
      context.save();
      context.shadowColor = 'rgba(197, 255, 107, 0.9)';
      context.shadowBlur = radius * 1.6;
      context.beginPath();
      context.arc(x * scaleX, y * scaleY, isCursor ? radius : radius * 0.75, 0, Math.PI * 2);
      context.strokeStyle = '#c5ff6b';
      context.lineWidth = Math.max(2, radius * 0.22);
      context.stroke();
      context.shadowBlur = 0;
      context.beginPath();
      context.arc(x * scaleX, y * scaleY, Math.max(2.5, radius * 0.25), 0, Math.PI * 2);
      context.fillStyle = '#c5ff6b';
      context.fill();
      context.restore();
    }
  }
}
