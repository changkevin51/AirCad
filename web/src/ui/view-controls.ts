import { viewAvailability, type UiSnapshot } from './workspace-state';
import type { CommandCallbacks } from './command-bar';

interface ViewButton {
  button: HTMLButtonElement;
  baseTitle: string;
}

/**
 * The 32px viewport header: named views, projection and Fit as real buttons.
 * Presets are commands, not radio states — Top/Front/Right also pin the
 * matching work plane, which the tooltips state.
 */
export class ViewControls {
  private readonly buttons: ViewButton[] = [];
  private readonly projection: HTMLButtonElement;

  constructor(host: HTMLElement, cb: CommandCallbacks) {
    const add = (label: string, key: string, title: string, action: 'viewTop' | 'viewFront' | 'viewRight' | 'viewIso' | 'fitAll') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ws-btn ws-btn--view';
      button.title = title;
      const text = document.createElement('span');
      text.textContent = label;
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      button.append(text, kbd);
      let pointerActivated = false;
      button.addEventListener('pointerdown', () => {
        pointerActivated = true;
      });
      button.addEventListener('click', () => {
        cb.dispatch({ type: 'press', action });
        if (pointerActivated) cb.focusViewport();
        pointerActivated = false;
      });
      this.buttons.push({ button, baseTitle: title });
      host.appendChild(button);
    };

    add('Top', '1', 'Top view (1) — also pins the XY work plane', 'viewTop');
    add('Front', '2', 'Front view (2) — also pins the XZ work plane', 'viewFront');
    add('Right', '3', 'Right view (3) — also pins the YZ work plane', 'viewRight');
    add('Iso', '0', 'Isometric view (0)', 'viewIso');

    this.projection = document.createElement('button');
    this.projection.type = 'button';
    this.projection.className = 'ws-btn ws-btn--view';
    this.projection.title = 'Orthographic / perspective (5)';
    const projText = document.createElement('span');
    projText.textContent = 'Ortho';
    const projKbd = document.createElement('kbd');
    projKbd.textContent = '5';
    this.projection.append(projText, projKbd);
    this.projection.setAttribute('aria-pressed', 'false');
    let projPointer = false;
    this.projection.addEventListener('pointerdown', () => {
      projPointer = true;
    });
    this.projection.addEventListener('click', () => {
      cb.dispatch({ type: 'press', action: 'toggleProjection' });
      if (projPointer) cb.focusViewport();
      projPointer = false;
    });
    this.buttons.push({ button: this.projection, baseTitle: 'Orthographic / perspective (5)' });
    host.appendChild(this.projection);

    add('Fit', 'F', 'Fit the sketch in view (F)', 'fitAll');
  }

  update(snapshot: UiSnapshot): void {
    const availability = viewAvailability(snapshot);
    for (const { button, baseTitle } of this.buttons) {
      button.disabled = !availability.enabled;
      if (availability.enabled) {
        button.removeAttribute('data-reason');
        button.title = baseTitle;
      } else {
        button.dataset.reason = availability.reason ?? 'Unavailable';
        button.title = availability.reason ?? 'Unavailable';
      }
    }
    this.projection.setAttribute('aria-pressed', String(snapshot.ortho));
    const text = this.projection.querySelector('span');
    if (text) text.textContent = snapshot.ortho ? 'Persp' : 'Ortho';
  }
}
