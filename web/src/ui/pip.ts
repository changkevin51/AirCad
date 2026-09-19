import { regionRect } from '../input/cursor';
import type { CameraState, HandsMessage, ThumbMessage } from '../input/tracker-client';

/** Camera picture-in-picture with the fingertip and the active mapping region. */
export class CameraPip {
  private readonly element: HTMLDivElement;
  private readonly image = new Image();
  private readonly canvas = document.createElement('canvas');
  private readonly caption = document.createElement('div');
  private hands: HandsMessage | null = null;
  private cursorHandId: number | null = null;
  private imageSize = { w: 192, h: 144 };
  visible = true;

  constructor(root: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'pip';
    this.image.className = 'pip__image';
    this.image.alt = 'camera preview';
    this.canvas.className = 'pip__overlay';
    this.caption.className = 'pip__caption';
    this.caption.textContent = 'Camera';
    this.element.append(this.image, this.canvas, this.caption);
    root.appendChild(this.element);
    this.image.onload = () => this.draw();
  }

  setThumb(message: ThumbMessage): void {
    this.imageSize = { w: message.w, h: message.h };
    this.image.src = `data:image/jpeg;base64,${message.jpeg}`;
  }

  setHands(message: HandsMessage, cursorHandId: number | null): void {
    this.hands = message;
    this.cursorHandId = cursorHandId;
    this.draw();
  }

  setCameraState(state: CameraState | null, connected: boolean): void {
    if (!connected) this.caption.textContent = 'Tracker offline';
    else if (state === 'disabled') this.caption.textContent = 'Camera disabled (--no-camera)';
    else if (state === 'error') this.caption.textContent = 'Camera error - see terminal';
    else if (state === 'starting') this.caption.textContent = 'Camera starting...';
    else this.caption.textContent = 'Camera - stay inside the box';
    this.element.classList.toggle('pip--inactive', !connected || state !== 'ready');
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.element.classList.toggle('hidden', !this.visible);
    return this.visible;
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
    const hands = this.hands;
    if (!hands) return;
    const scaleX = w / hands.frame.w;
    const scaleY = h / hands.frame.h;
    const region = regionRect(hands.frame);
    context.strokeStyle = 'rgba(111, 227, 180, 0.9)';
    context.lineWidth = 1.5;
    context.setLineDash([4, 3]);
    context.strokeRect(region.x * scaleX, region.y * scaleY, region.w * scaleX, region.h * scaleY);
    context.setLineDash([]);
    for (const hand of hands.hands) {
      const isCursor = hand.id === this.cursorHandId;
      const [x, y] = hand.tip;
      context.beginPath();
      context.arc(x * scaleX, y * scaleY, isCursor ? 5 : 3.5, 0, Math.PI * 2);
      context.fillStyle = isCursor ? '#ffc857' : 'rgba(255,255,255,0.7)';
      context.fill();
      if (hand.openArmed) {
        const [px, py] = hand.palm;
        context.beginPath();
        context.arc(px * scaleX, py * scaleY, 8, 0, Math.PI * 2);
        context.strokeStyle = '#8ab4f8';
        context.lineWidth = 2;
        context.stroke();
      }
    }
  }
}
