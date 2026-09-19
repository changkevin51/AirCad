import {
  GROUP_TITLES,
  HOLD_BINDINGS,
  keyLabel,
  MOUSE_HELP,
  PRESS_BINDINGS,
  type BindingGroup,
  type KeyBinding,
  type Platform,
} from '../input/keymap';

const WALKTHROUGH = [
  'Press 1 for the top view and draw a closed rectangle: the floor (e.g. 4000 x 3000).',
  'Press 0 for the isometric view, then Tab until the plane chip says XZ Front.',
  'Hover a floor corner until the cursor becomes a square (vertex snap), hold Space and draw a rectangle upwards: the plane moves through that corner, so the wall stands on the floor.',
  'Tab to YZ Right, hover another corner and draw the side wall the same way.',
  'Roof: hover a wall top corner, hold Space and draw a straight line to the opposite wall top. Vertex snaps connect the ends exactly.',
  'Press L to type an exact size (4000 or 4000x3000) for the hovered or last entity, E to export to FreeCAD.',
];

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Full-screen help overlay generated from the keymap. */
export class HelpOverlay {
  private readonly element: HTMLDivElement;
  visible = false;

  constructor(root: HTMLElement, platform: Platform) {
    this.element = document.createElement('div');
    this.element.className = 'help hidden';
    this.element.innerHTML = this.render(platform);
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) this.hide();
    });
    root.appendChild(this.element);
  }

  private render(platform: Platform): string {
    const groups: BindingGroup[] = ['pen', 'view', 'plane', 'edit', 'tools'];
    const all: KeyBinding<string>[] = [...HOLD_BINDINGS, ...PRESS_BINDINGS];
    const sections = groups
      .map((group) => {
        const rows = all
          .filter((binding) => binding.group === group)
          .map((binding) => `<tr><td><kbd>${escapeHtml(keyLabel(binding, platform))}</kbd></td><td>${escapeHtml(binding.help)}</td></tr>`)
          .join('');
        return `<section><h3>${GROUP_TITLES[group]}</h3><table>${rows}</table></section>`;
      })
      .join('');
    const mouse = MOUSE_HELP.map((item) => `<tr><td><kbd>${item.label}</kbd></td><td>${escapeHtml(item.help)}</td></tr>`).join('');
    const steps = WALKTHROUGH.map((step) => `<li>${escapeHtml(step)}</li>`).join('');
    return `
      <div class="help__panel">
        <header><h2>AirCAD - pen sketching in 3D</h2><span>H or Esc to close</span></header>
        <p class="help__intro">
          Your index fingertip (or the mouse) is the cursor. Keys stand in for the pen buttons:
          hold <kbd>Space</kbd> to draw a straight line or a closed rectangle on the work plane,
          hold <kbd>Shift</kbd> to orbit and <kbd>Ctrl</kbd> to pan. Everything is in millimetres.
        </p>
        <div class="help__grid">
          ${sections}
          <section><h3>Mouse</h3><table>${mouse}</table></section>
          <section class="help__walkthrough"><h3>Sketch a house</h3><ol>${steps}</ol></section>
        </div>
      </div>`;
  }

  show(): void {
    this.visible = true;
    this.element.classList.remove('hidden');
  }

  hide(): void {
    this.visible = false;
    this.element.classList.add('hidden');
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }
}
