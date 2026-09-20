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
import { openDialog, type DialogHandle } from './dialog';

export type HelpSection = 'getting-started' | 'drawing' | 'push-pull' | 'camera' | 'keys' | 'legacy';

const SECTIONS: { id: HelpSection; label: string }[] = [
  { id: 'getting-started', label: 'Getting started' },
  { id: 'drawing', label: 'Drawing and planes' },
  { id: 'push-pull', label: 'Push/Pull' },
  { id: 'camera', label: 'Camera setup' },
  { id: 'keys', label: 'Keyboard and mouse' },
  { id: 'legacy', label: 'Legacy' },
];

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

/** Structured, scrollable help dialog generated from the keymap. */
export class HelpOverlay {
  visible = false;
  private dialog: DialogHandle | null = null;
  private readonly sections = new Map<HelpSection, HTMLElement>();
  private readonly navButtons = new Map<HelpSection, HTMLButtonElement>();
  private readonly body: HTMLElement;

  constructor(private readonly host: HTMLElement, platform: Platform) {
    this.body = document.createElement('div');
    this.body.className = 'help-body';

    const nav = document.createElement('nav');
    nav.className = 'help-nav';
    nav.setAttribute('aria-label', 'Help sections');
    const content = document.createElement('div');
    content.className = 'help-content';

    for (const section of SECTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'help-nav__item';
      button.textContent = section.label;
      button.addEventListener('click', () => this.showSection(section.id));
      nav.appendChild(button);
      this.navButtons.set(section.id, button);

      const panel = document.createElement('section');
      panel.className = 'help-section hidden';
      panel.innerHTML = this.renderSection(section.id, platform);
      content.appendChild(panel);
      this.sections.set(section.id, panel);
    }

    this.body.append(nav, content);
  }

  private renderSection(section: HelpSection, platform: Platform): string {
    switch (section) {
      case 'getting-started':
        return `<h3>Getting started</h3>
          ${paragraph('AirCAD is a sketch-first modeler: you draw on a work plane, then push or pull shapes into solids. Everything is in millimetres; typed values also accept cm and m.')}
          <ol>
            <li>Left-drag on the canvas — or hold <kbd>Space</kbd> and move — to draw. A straight stroke becomes a line; a closed loop squares up to a rectangle when it is even loosely box-like (including round loops), otherwise a fitted triangle or a polygon. Snapped lines can still assemble an outline. A webcam pinch selects or pulls; it does not draw.</li>
            <li>Click a shape (or press <kbd>S</kbd> under the cursor) to select it. The Model panel and the Properties inspector follow the same selection.</li>
            <li>Type exact dimensions with <kbd>L</kbd>, or edit Width/Height/Depth in the Properties inspector. <kbd>M</kbd> moves a selected shape; <kbd>R</kbd> scales from a corner.</li>
            <li><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Shift+Z</kbd> undo and redo; <kbd>Delete</kbd> removes the selected object.</li>
            <li>Clear sketch in the Edit menu asks for confirmation. The shortcut <kbd>Ctrl+Backspace</kbd> clears immediately — both are undoable.</li>
            <li>Display in the view header switches X-ray (see-through) and Shaded (opaque). <kbd>D</kbd> Reveal hides the editing chrome for a read-only look at the finished model; <kbd>D</kbd> or <kbd>Esc</kbd> returns.</li>
            <li>AirCAD → Save sketch downloads the model as millimetre JSON. Open sketch… replaces the scene after confirmation and clears undo history. There is no autosave.</li>
          </ol>`;
      case 'drawing':
        return `<h3>Drawing and planes</h3>
          ${paragraph('Strokes land on the work plane — XY (Top), XZ (Front), or YZ (Right). The status bar shows the current plane and whether it is Auto or pinned.')}
          <ul>
            <li><kbd>Tab</kbd> on the canvas cycles the work plane and pins it; <kbd>A</kbd> toggles back to automatic inference; <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> jump to a view and pin its plane.</li>
            <li>The canvas keeps <kbd>Tab</kbd> for plane cycling. Use <kbd>F6</kbd> / <kbd>Shift+F6</kbd> to move focus between the app bar, panels, and the viewport.</li>
            <li><kbd>Space</kbd> and <kbd>Enter</kbd> on buttons and fields activate the control — they never draw. Drawing keys only work while the canvas has focus.</li>
            <li><kbd>G</kbd> toggles grid snapping; while drawing, <kbd>X</kbd>/<kbd>Y</kbd>/<kbd>Z</kbd> lock the stroke to an axis.</li>
            <li>Snapping finds vertices, midpoints, edges, and shared borders: draw a closed loop against an existing rectangle to complete a wall. A nearly parallel stroke can pick up an existing edge's direction and length.</li>
          </ul>`;
      case 'push-pull':
        return `<h3>Push/Pull</h3>
          <ol>
            <li>Select a closed outline or solid and press <kbd>Q</kbd> (or the Push/Pull button). The face most facing you is highlighted — hover another face, press <kbd>Tab</kbd>, or use the Face select in the inspector.</li>
            <li>Left-drag or hold <kbd>Space</kbd> and move to pull the face out or push it in. Release pauses; grab again to keep adjusting.</li>
            <li>Type an exact pull distance with <kbd>L</kbd>, or use the Pull distance field in the inspector — Update preview adjusts the preview without committing.</li>
            <li><kbd>Shift</kbd>/<kbd>Ctrl</kbd> orbit and pan mid-operation; release to continue pulling without a depth jump.</li>
            <li><kbd>Enter</kbd>, <kbd>Q</kbd>, or the inspector's Apply commits exactly one edit; <kbd>Esc</kbd> or Cancel restores the original.</li>
          </ol>`;
      case 'camera':
        return `<h3>Camera setup</h3>
          ${paragraph('The mouse always works. Tracking is configured in the Input tab of the inspector.')}
          <ul>
            <li>Camera tracking follows the green keycap center. Hold <kbd>Space</kbd> to draw or grab; release to finish the grab. Press <kbd>S</kbd> to select. Hold <kbd>Shift</kbd> to orbit or <kbd>Ctrl</kbd> to pan; <kbd>+</kbd>/<kbd>−</kbd> zoom. <kbd>P</kbd> toggles the camera preview.</li>
            <li>An OAK-D depth camera draws on the work plane after <kbd>O</kbd> sets the origin; <kbd>Shift+R</kbd> recenters on the last endpoint.</li>
            <li>If tracking pauses, show the green keycap again to resume — holds always release on focus loss, so nothing stays latched.</li>
            <li>The four-button pen remote sends <kbd>F17</kbd>-<kbd>F20</kbd>: button 1 holds to draw / orbit / pan by mode, taps to select, double-taps to undo; button 2 cycles the mode; button 3 taps for <kbd>Tab</kbd> and holds for voice; button 4 taps for push/pull and holds to move. Buttons 2+4 fit the view, 2+3 release everything.</li>
          </ul>`;
      case 'keys': {
        const groups: BindingGroup[] = ['pen', 'view', 'plane', 'edit', 'tools'];
        const all: KeyBinding<string>[] = [...HOLD_BINDINGS, ...PRESS_BINDINGS];
        const tables = groups
          .map((group) => {
            const rows = all
              .filter((binding) => binding.group === group)
              .map((binding) => `<tr><td><kbd>${escapeHtml(keyLabel(binding, platform))}</kbd></td><td>${escapeHtml(binding.help)}</td></tr>`)
              .join('');
            return `<section><h4>${GROUP_TITLES[group]}</h4><table>${rows}</table></section>`;
          })
          .join('');
        const mouse = MOUSE_HELP.map((item) => `<tr><td><kbd>${escapeHtml(item.label)}</kbd></td><td>${escapeHtml(item.help)}</td></tr>`).join('');
        return `<h3>Keyboard and mouse</h3><section><h4>Mouse</h4><table>${mouse}</table></section>${tables}`;
      }
      case 'legacy':
        return `<h3>Legacy</h3>
          <details>
            <summary>FreeCAD export</summary>
            ${paragraph('Press E or use AirCAD → Legacy → "Export to FreeCAD" to send the current sketch to a separately installed FreeCAD application. AirCAD does not require it. Native modeling is saved with AirCAD → Save sketch (local JSON download); Open sketch… replaces the scene and clears undo history. There is no autosave.')}
          </details>`;
    }
  }

  private showSection(section: HelpSection): void {
    for (const [id, panel] of this.sections) panel.classList.toggle('hidden', id !== section);
    for (const [id, button] of this.navButtons) button.setAttribute('aria-current', id === section ? 'true' : 'false');
  }

  show(section: HelpSection = 'getting-started'): void {
    if (!this.dialog) {
      this.dialog = openDialog({
        host: this.host,
        title: 'AirCAD help',
        body: this.body,
        backdropClose: true,
        size: 'wide',
        onClose: () => {
          this.dialog = null;
          this.visible = false;
        },
      });
    }
    this.visible = true;
    this.showSection(section);
  }

  hide(): void {
    this.dialog?.close();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }
}
