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
  'Press 0 for the isometric view, then Tab until the plane preview shows XZ Front.',
  'Hold Space starting on a floor border and draw the other three sides of the wall upwards: one continuous stroke completes against the shared border. Or draw the three sides as three separately committed straight strokes; the third one assembles the wall.',
  'Tab until YZ Right and repeat on the side borders to raise the other walls, then snap a roof line between wall-top vertices.',
  'Draw roughly the same-sized rectangle beside an existing one to align the whole shared border and nearby dimensions; the preview shows the snapped result. Clearly smaller attachments stay partial.',
  'A switches to optional Auto mode: the work plane follows the view and what you hover (a face interior, an edge, or a vertex). Check the plane preview and use Tab or 1 / 2 / 3 when the choice is ambiguous; the plane locks while you draw and never moves mid-stroke.',
  'Views 1 / 2 / 3 / 0 glide smoothly, and releasing an orbit within 6 degrees of a view settles onto it.',
  'Press L to type an exact size (4000 or 4000x3000) for the selected, hovered, or last entity, E to export to FreeCAD.',
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
          hold <kbd>Space</kbd> to draw a straight line, a closed rectangle or triangle, or three wall sides onto a shared border on the work plane,
          hold <kbd>Shift</kbd> to orbit and <kbd>Ctrl</kbd> to pan. Everything is in millimetres.
          An optional OAK-D depth camera draws on the work plane after you press <kbd>O</kbd> to set the origin.
        </p>
        <div class="help__grid">
          <section class="help__walkthrough"><h3>Push/pull a face</h3><ol>
            <li>Point inside a rectangle, triangle, or solid and pinch thumb + index, click, or press <kbd>S</kbd> to select it. Its outline stays highlighted.</li>
            <li>Press <kbd>Q</kbd>. The face most facing you is highlighted — hover another face or press <kbd>Tab</kbd> to switch which side you push/pull.</li>
            <li>Pinch and move to pull the highlighted face out, or back to push it in. Mouse: left-drag or hold <kbd>Space</kbd>.</li>
            <li>Release to pause, then grab again to keep adjusting. <kbd>L</kbd> types an exact pull distance; negative values push in.</li>
            <li>Hold <kbd>Shift</kbd> to orbit or <kbd>Ctrl</kbd> to pan while pulling. Release the key to continue the pull without changing its depth.</li>
            <li><kbd>Enter</kbd> or <kbd>Q</kbd> applies; <kbd>Esc</kbd> cancels. Press <kbd>0</kbd> for a 3D view. Undo restores the original shape.</li>
          </ol></section>
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
