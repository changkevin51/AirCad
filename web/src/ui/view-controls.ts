import type { PressAction } from '../input/keymap';
import type { DisplayStyle } from '../render/sketch-renderer';
import {
  displayStyleAvailability,
  pressAvailability,
  revealAvailability,
  type UiSnapshot,
} from './workspace-state';
import type { CommandCallbacks } from './command-bar';

interface ViewButton {
  button: HTMLButtonElement;
  baseTitle: string;
  action: PressAction;
}

const DISPLAY_STYLES: readonly { value: DisplayStyle; label: string }[] = [
  { value: 'xray', label: 'X-ray' },
  { value: 'shaded', label: 'Shaded' },
];

/**
 * The 32px viewport header: named views, projection and Fit as real buttons.
 * Presets are commands, not radio states — Top/Front/Right also pin the
 * matching work plane, which the tooltips state.  The Display style select
 * and Reveal button carry `data-cad-preserve-draft` so activating them while
 * a draft is live rejects the action instead of destroying the stroke.
 */
export class ViewControls {
  private readonly buttons: ViewButton[] = [];
  private readonly projection: HTMLButtonElement;
  private readonly displayField: HTMLLabelElement;
  private readonly displaySelect: HTMLSelectElement;
  private readonly reveal: HTMLButtonElement;
  private readonly revealText: HTMLSpanElement;
  private readonly revealKbd: HTMLElement;

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
      this.buttons.push({ button, baseTitle: title, action });
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
    this.buttons.push({ button: this.projection, baseTitle: 'Orthographic / perspective (5)', action: 'toggleProjection' });
    host.appendChild(this.projection);

    add('Fit', 'F', 'Fit the sketch in view (F)', 'fitAll');

    this.displayField = document.createElement('label');
    this.displayField.className = 'ws-field ws-view-header__display';
    this.displayField.setAttribute('data-cad-preserve-draft', '');
    const displayText = document.createElement('span');
    displayText.textContent = 'Display';
    this.displaySelect = document.createElement('select');
    this.displaySelect.setAttribute('aria-label', 'Display style');
    for (const { value, label } of DISPLAY_STYLES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.displaySelect.appendChild(option);
    }
    let displayPointer = false;
    this.displaySelect.addEventListener('pointerdown', () => {
      displayPointer = true;
    });
    this.displaySelect.addEventListener('change', () => {
      cb.dispatch({ type: 'setDisplayStyle', style: this.displaySelect.value as DisplayStyle });
      if (displayPointer) cb.focusViewport();
      displayPointer = false;
    });
    this.displaySelect.addEventListener('blur', () => {
      displayPointer = false;
    });
    this.displayField.append(displayText, this.displaySelect);
    host.appendChild(this.displayField);

    this.reveal = document.createElement('button');
    this.reveal.type = 'button';
    this.reveal.className = 'ws-btn ws-btn--view ws-view-header__reveal';
    this.reveal.setAttribute('data-cad-preserve-draft', '');
    this.revealText = document.createElement('span');
    this.revealText.textContent = 'Reveal';
    this.revealKbd = document.createElement('kbd');
    this.revealKbd.textContent = 'D';
    this.reveal.append(this.revealText, this.revealKbd);
    let revealPointer = false;
    this.reveal.addEventListener('pointerdown', () => {
      revealPointer = true;
    });
    this.reveal.addEventListener('click', () => {
      cb.dispatch({ type: 'press', action: 'reveal' });
      if (revealPointer) cb.focusViewport();
      revealPointer = false;
    });
    host.appendChild(this.reveal);
  }

  update(snapshot: UiSnapshot): void {
    for (const { button, baseTitle, action } of this.buttons) {
      const availability = pressAvailability(action, snapshot);
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

    const styleAvailability = displayStyleAvailability(snapshot);
    this.displayField.classList.toggle('hidden', snapshot.presenting);
    this.displaySelect.disabled = !styleAvailability.enabled;
    this.displayField.title = styleAvailability.enabled
      ? 'Face shading — X-ray shows interior edges, Shaded is opaque'
      : styleAvailability.reason ?? 'Unavailable';
    if (document.activeElement !== this.displaySelect) this.displaySelect.value = snapshot.displayStyle;

    const reveal = revealAvailability(snapshot);
    this.reveal.disabled = !reveal.enabled;
    this.reveal.title = snapshot.presenting
      ? 'Back to editing (D or Esc)'
      : reveal.enabled
        ? 'Reveal the finished model (D)'
        : reveal.reason ?? 'Unavailable';
    this.revealText.textContent = snapshot.presenting ? 'Back to editing' : 'Reveal';
    this.revealKbd.textContent = snapshot.presenting ? 'D · Esc' : 'D';
  }
}
