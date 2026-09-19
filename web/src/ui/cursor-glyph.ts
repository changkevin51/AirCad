import type { SnapResult } from '../model/snap';
import type { Vec2 } from '../model/vec';

function fmt(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/** DOM cursor: the glyph shape encodes the snap type; a small readout shows x y z in mm. */
export class CursorGlyph {
  private readonly element: HTMLDivElement;
  private readonly glyph: HTMLDivElement;
  private readonly rawDot: HTMLDivElement;
  private readonly readout: HTMLDivElement;
  private lastClass = '';

  constructor(root: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'cursor hidden';
    this.glyph = document.createElement('div');
    this.glyph.className = 'cursor__glyph';
    this.readout = document.createElement('div');
    this.readout.className = 'cursor__readout';
    this.element.append(this.glyph, this.readout);
    this.rawDot = document.createElement('div');
    this.rawDot.className = 'cursor__raw hidden';
    root.append(this.rawDot, this.element);
  }

  update(snap: SnapResult | null, rawCursor: Vec2 | null, drawing: boolean): void {
    if (!snap || !rawCursor) {
      this.element.classList.add('hidden');
      this.rawDot.classList.add('hidden');
      return;
    }
    this.element.classList.remove('hidden');
    this.element.style.transform = `translate(${snap.screen.x}px, ${snap.screen.y}px)`;
    const className = `cursor__glyph cursor__glyph--${snap.type}${drawing ? ' cursor__glyph--drawing' : ''}${snap.onPlane ? '' : ' cursor__glyph--offplane'}`;
    if (className !== this.lastClass) {
      this.lastClass = className;
      this.glyph.className = className;
      this.glyph.textContent = snap.type === 'lock' || snap.type === 'axis' ? (snap.axis ?? '').toUpperCase() : '';
    }
    this.readout.textContent = `${fmt(snap.world.x)}  ${fmt(snap.world.y)}  ${fmt(snap.world.z)} mm`;
    const jumped = Math.hypot(snap.screen.x - rawCursor.x, snap.screen.y - rawCursor.y) > 2;
    this.rawDot.classList.toggle('hidden', !jumped);
    if (jumped) this.rawDot.style.transform = `translate(${rawCursor.x}px, ${rawCursor.y}px)`;
  }
}
