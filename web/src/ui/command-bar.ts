import type { HelpSection } from './help';
import { formatGridStep } from './hud';
import { icons } from './icons';
import type { InspectorTab } from './workspace';
import {
  clearAvailability,
  deleteAvailability,
  dimensionsAvailability,
  fileAvailability,
  pressAvailability,
  pushPullAvailability,
  viewAvailability,
  workPlaneAvailability,
  type CommandAvailability,
  type UiActionResult,
  type UiSnapshot,
  type WorkspaceAction,
} from './workspace-state';

/** Everything the command surfaces can ask the App to do. */
export interface CommandCallbacks {
  dispatch(action: WorkspaceAction): UiActionResult;
  togglePanel(panel: 'browser' | 'inspector'): void;
  openInspectorTab(tab: InspectorTab): void;
  /** Open the structured help dialog on a section. */
  openHelp(section?: HelpSection): void;
  /** Visible Clear goes through a confirmation dialog before `press('clear')`. */
  requestClear(): void;
  focusViewport(): void;
}

/**
 * Buttons that fire one-shot CAD commands restore viewport focus when they
 * were activated by pointer; keyboard activation keeps focus on the control.
 */
function commandButton(
  label: string,
  title: string,
  onActivate: () => void,
  focusViewport: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ws-btn';
  button.title = title;
  button.textContent = label;
  let pointerActivated = false;
  button.addEventListener('pointerdown', () => {
    pointerActivated = true;
  });
  button.addEventListener('click', () => {
    onActivate();
    if (pointerActivated) focusViewport();
    pointerActivated = false;
  });
  return button;
}

function applyAvailability(button: HTMLButtonElement | HTMLSelectElement, availability: CommandAvailability): void {
  // Remember the enabled-state tooltip once so re-enabling restores it.
  if (!button.dataset.baseTitle) button.dataset.baseTitle = button.title;
  button.disabled = !availability.enabled;
  if (availability.enabled) {
    button.removeAttribute('data-reason');
    button.title = button.dataset.baseTitle;
  } else {
    button.dataset.reason = availability.reason ?? 'Unavailable';
    button.title = availability.reason ?? 'Unavailable';
  }
}

interface MenuItem {
  checkable?: 'browser' | 'inspector' | 'pip';
  label: string;
  shortcut?: string;
  availability?: (snap: UiSnapshot) => CommandAvailability;
  action(): void;
}

const CHECKED: Record<NonNullable<MenuItem['checkable']>, keyof UiSnapshot> = {
  browser: 'browserVisible',
  inspector: 'inspectorVisible',
  pip: 'pipVisible',
};

/** A button + dropdown panel pair; Escape or an outside click closes it. */
class Disclosure {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLDivElement;
  private openState = false;

  constructor(
    label: string,
    private readonly onToggle: (open: boolean) => void,
  ) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'ws-btn ws-menubtn';
    this.button.setAttribute('aria-haspopup', 'true');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.innerHTML = `${label}<span class="ws-caret">${icons.chevron}</span>`;
    this.panel = document.createElement('div');
    this.panel.className = 'ws-menu hidden';
    this.button.addEventListener('click', () => this.toggle());
    this.panel.addEventListener('keydown', (event) => {
      if (event.code === 'Escape') {
        event.preventDefault();
        this.close();
        this.button.focus();
      }
    });
  }

  get open(): boolean {
    return this.openState;
  }

  toggle(): void {
    this.openState ? this.close() : this.show();
  }

  show(): void {
    this.openState = true;
    this.panel.classList.remove('hidden');
    this.button.setAttribute('aria-expanded', 'true');
    this.onToggle(true);
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.panel.classList.add('hidden');
    this.button.setAttribute('aria-expanded', 'false');
    this.onToggle(false);
  }
}

/** Top application bar: AirCAD/Edit/View/Help disclosures, session label, panel toggles. */
export class AppBar {
  private readonly disclosures: Disclosure[] = [];
  private readonly items: { button: HTMLButtonElement; item: MenuItem }[] = [];
  private readonly browserToggle: HTMLButtonElement;
  private readonly inspectorToggle: HTMLButtonElement;

  constructor(host: HTMLElement, cb: CommandCallbacks) {
    const menus = el('div', 'ws-app-bar__menus');

    const aircad = this.addDisclosure(menus, 'AirCAD');
    aircad.button.setAttribute('data-cad-preserve-draft', '');
    aircad.panel.setAttribute('data-cad-preserve-draft', '');
    const saveItem = this.bindItem({
      label: 'Save sketch',
      shortcut: 'Ctrl+S',
      availability: (s: UiSnapshot) => fileAvailability(s, 'save'),
      action: () => cb.dispatch({ type: 'press', action: 'saveSketch' }),
    }, aircad);
    const openItem = this.bindItem({
      label: 'Open sketch…',
      shortcut: 'Ctrl+O',
      availability: (s: UiSnapshot) => fileAvailability(s, 'open'),
      action: () => cb.dispatch({ type: 'press', action: 'openSketch' }),
    }, aircad);
    saveItem.setAttribute('data-cad-preserve-draft', '');
    openItem.setAttribute('data-cad-preserve-draft', '');
    aircad.panel.append(saveItem, openItem);
    const legacyLabel = document.createElement('button');
    legacyLabel.type = 'button';
    legacyLabel.className = 'ws-menu-item';
    legacyLabel.setAttribute('aria-expanded', 'false');
    legacyLabel.innerHTML = `Legacy<span class="ws-caret">${icons.chevron}</span>`;
    const legacyPanel = document.createElement('div');
    legacyPanel.className = 'ws-submenu hidden';
    const exportItem = this.menuItem('Export to FreeCAD', 'E', () => cb.dispatch({ type: 'press', action: 'export' }));
    const note = document.createElement('div');
    note.className = 'ws-menu-note';
    note.textContent = 'Requires the separately installed FreeCAD application.';
    legacyPanel.append(exportItem, note);
    legacyLabel.addEventListener('click', () => {
      const open = legacyPanel.classList.toggle('hidden');
      legacyLabel.setAttribute('aria-expanded', String(!open));
    });
    aircad.panel.append(legacyLabel, legacyPanel);

    const edit = this.addDisclosure(menus, 'Edit');
    for (const item of [
      { label: 'Undo', shortcut: 'Ctrl+Z', availability: (s: UiSnapshot) => pressAvailability('undo', s), action: () => cb.dispatch({ type: 'press', action: 'undo' }) },
      { label: 'Redo', shortcut: 'Ctrl+Shift+Z', availability: (s: UiSnapshot) => pressAvailability('redo', s), action: () => cb.dispatch({ type: 'press', action: 'redo' }) },
      { label: 'Delete selected', shortcut: 'Del', availability: (s: UiSnapshot) => deleteAvailability(s.selected, s), action: () => cb.dispatch({ type: 'press', action: 'delete' }) },
      { label: 'Clear sketch', shortcut: 'Ctrl+Backspace', availability: (s: UiSnapshot) => clearAvailability(s), action: () => cb.requestClear() },
    ] satisfies MenuItem[]) {
      edit.panel.appendChild(this.bindItem(item, edit));
    }

    const view = this.addDisclosure(menus, 'View');
    const viewAvail = (s: UiSnapshot) => viewAvailability(s);
    for (const item of [
      { label: 'Top', shortcut: '1', availability: viewAvail, action: () => cb.dispatch({ type: 'press', action: 'viewTop' }) },
      { label: 'Front', shortcut: '2', availability: viewAvail, action: () => cb.dispatch({ type: 'press', action: 'viewFront' }) },
      { label: 'Right', shortcut: '3', availability: viewAvail, action: () => cb.dispatch({ type: 'press', action: 'viewRight' }) },
      { label: 'Isometric', shortcut: '0', availability: viewAvail, action: () => cb.dispatch({ type: 'press', action: 'viewIso' }) },
      { label: 'Orthographic / Perspective', shortcut: '5', availability: viewAvail, action: () => cb.dispatch({ type: 'press', action: 'toggleProjection' }) },
      { label: 'Fit', shortcut: 'F', availability: viewAvail, action: () => cb.dispatch({ type: 'press', action: 'fitAll' }) },
      { label: 'Model panel', checkable: 'browser', action: () => cb.togglePanel('browser') },
      { label: 'Inspector panel', checkable: 'inspector', action: () => cb.togglePanel('inspector') },
      {
        label: 'Camera preview',
        shortcut: 'P',
        checkable: 'pip',
        availability: (s: UiSnapshot) =>
          s.inputLabel === 'Mouse'
            ? { enabled: false, reason: 'Camera preview needs a camera input' }
            : { enabled: true },
        action: () => cb.dispatch({ type: 'press', action: 'togglePip' }),
      },
    ] satisfies MenuItem[]) {
      view.panel.appendChild(this.bindItem(item, view));
    }

    const help = this.addDisclosure(menus, 'Help');
    help.panel.appendChild(this.bindItem({ label: 'Getting started', action: () => cb.openHelp('getting-started') }, help));
    help.panel.appendChild(this.bindItem({ label: 'Keyboard shortcuts', action: () => cb.openHelp('keys') }, help));

    const title = el('div', 'ws-app-bar__title');
    title.textContent = 'Sketch · mm';
    title.title = 'Local millimetre sketch. Save downloads a JSON file; Open replaces the scene and clears undo history. There is no autosave.';

    const right = el('div', 'ws-app-bar__right');
    this.browserToggle = this.panelToggle('Model panel', icons.panelLeft, () => cb.togglePanel('browser'));
    this.inspectorToggle = this.panelToggle('Inspector panel', icons.panelRight, () => cb.togglePanel('inspector'));
    right.append(this.browserToggle, this.inspectorToggle);

    host.append(menus, title, right);
    document.addEventListener('pointerdown', (event) => {
      if (!(event.target as HTMLElement | null)?.closest?.('.ws-app-bar')) this.closeAll();
    });
  }

  private panelToggle(label: string, icon: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ws-iconbtn';
    button.innerHTML = icon;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'true');
    button.addEventListener('click', action);
    return button;
  }

  private addDisclosure(menus: HTMLElement, label: string): Disclosure {
    const disclosure = new Disclosure(label, (open) => {
      if (open) for (const other of this.disclosures) if (other !== disclosure) other.close();
    });
    this.disclosures.push(disclosure);
    const wrap = el('div', 'ws-menubtn-wrap');
    wrap.append(disclosure.button, disclosure.panel);
    menus.appendChild(wrap);
    return disclosure;
  }

  private menuItem(label: string, shortcut: string | undefined, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ws-menu-item';
    button.textContent = label;
    if (shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = shortcut;
      button.appendChild(kbd);
    }
    button.addEventListener('click', action);
    return button;
  }

  private bindItem(item: MenuItem, disclosure: Disclosure): HTMLButtonElement {
    const button = this.menuItem(item.label, item.shortcut, () => {
      // Restore focus to the menu button first so a dialog opened by the
      // action captures it as the element to return focus to on close.
      this.closeAll();
      disclosure.button.focus();
      item.action();
    });
    if (item.checkable || item.availability) this.items.push({ button, item });
    return button;
  }

  private closeAll(): void {
    for (const disclosure of this.disclosures) disclosure.close();
  }

  update(snapshot: UiSnapshot): void {
    this.browserToggle.setAttribute('aria-pressed', String(snapshot.browserVisible));
    this.inspectorToggle.setAttribute('aria-pressed', String(snapshot.inspectorVisible));
    for (const { button, item } of this.items) {
      if (item.checkable) {
        button.setAttribute('aria-pressed', String(snapshot[CHECKED[item.checkable]]));
      }
      if (item.availability) applyAvailability(button, item.availability(snapshot));
    }
  }
}

const PLANE_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'xy', label: 'XY — Top' },
  { value: 'xz', label: 'XZ — Front' },
  { value: 'yz', label: 'YZ — Right' },
];

const SOURCE_FOR_PLANE: Record<string, 'XY' | 'XZ' | 'YZ'> = { xy: 'XY', xz: 'XZ', yz: 'YZ' };

/** Contextual modeling commands: operation buttons, work plane, grid snap, input entry. */
export class CommandBar {
  private readonly pushPull: HTMLButtonElement;
  private readonly dimensions: HTMLButtonElement;
  private readonly planeSelect: HTMLSelectElement;
  private readonly grid: HTMLButtonElement;
  private readonly gridStep: HTMLSpanElement;
  private readonly input: HTMLButtonElement;
  private readonly secondary: HTMLDivElement;
  private readonly more: HTMLButtonElement;

  constructor(host: HTMLElement, cb: CommandCallbacks) {
    const context = el('span', 'ws-context');
    context.textContent = 'Sketching';

    this.pushPull = commandButton('Push/Pull', 'Push/pull the selected closed outline or solid (Q)', () => {
      cb.dispatch({ type: 'press', action: 'extrude' });
    }, cb.focusViewport);
    const pushKbd = document.createElement('kbd');
    pushKbd.textContent = 'Q';
    this.pushPull.appendChild(pushKbd);

    this.dimensions = commandButton('Dimensions', 'Type an exact size for the selected object (L)', () => {
      cb.dispatch({ type: 'press', action: 'measure' });
    }, cb.focusViewport);
    const dimKbd = document.createElement('kbd');
    dimKbd.textContent = 'L';
    this.dimensions.appendChild(dimKbd);

    const planeLabel = el('label', 'ws-field');
    planeLabel.textContent = 'Work plane';
    this.planeSelect = document.createElement('select');
    for (const option of PLANE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      this.planeSelect.appendChild(opt);
    }
    planeLabel.appendChild(this.planeSelect);
    let planePointer = false;
    this.planeSelect.addEventListener('pointerdown', () => {
      planePointer = true;
    });
    this.planeSelect.addEventListener('change', () => {
      const value = this.planeSelect.value;
      cb.dispatch({
        type: 'setWorkPlane',
        plane: value === 'auto' ? 'auto' : SOURCE_FOR_PLANE[value],
      });
      if (planePointer) cb.focusViewport();
      planePointer = false;
    });

    this.grid = commandButton('Grid snap', 'Toggle grid snapping (G)', () => {
      cb.dispatch({ type: 'press', action: 'toggleGrid' });
    }, cb.focusViewport);
    this.grid.setAttribute('aria-pressed', 'true');
    this.gridStep = document.createElement('span');
    this.gridStep.className = 'ws-btn__secondary';
    this.grid.appendChild(this.gridStep);

    this.input = commandButton('Input: Mouse', 'Configure tracking input', () => {
      cb.openInspectorTab('input');
    }, cb.focusViewport);

    this.secondary = el('div', 'ws-command-secondary');
    this.secondary.append(planeLabel, this.grid, this.input);

    this.more = document.createElement('button');
    this.more.type = 'button';
    this.more.className = 'ws-btn ws-more';
    this.more.textContent = 'More';
    this.more.setAttribute('aria-expanded', 'false');
    this.more.addEventListener('click', () => {
      const open = this.secondary.classList.toggle('open');
      this.more.setAttribute('aria-expanded', String(open));
    });

    host.append(context, this.pushPull, this.dimensions, separator(), this.secondary, this.more);
  }

  update(snapshot: UiSnapshot): void {
    applyAvailability(this.pushPull, pushPullAvailability(snapshot.selected, snapshot));
    applyAvailability(this.dimensions, dimensionsAvailability(snapshot.selected, snapshot));
    applyAvailability(this.planeSelect, workPlaneAvailability(snapshot));
    const planeValue = snapshot.planeMode === 'auto' ? 'auto' : snapshot.planeKind.toLowerCase();
    if (document.activeElement !== this.planeSelect) this.planeSelect.value = planeValue;
    this.grid.setAttribute('aria-pressed', String(snapshot.gridEnabled));
    this.gridStep.textContent = snapshot.gridEnabled ? formatGridStep(snapshot.gridStep) : 'off';
    const inputLabel = `Input: ${snapshot.inputLabel}`;
    if (this.input.textContent !== inputLabel) this.input.textContent = inputLabel;
  }
}

function separator(): HTMLSpanElement {
  const sep = document.createElement('span');
  sep.className = 'ws-sep';
  return sep;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
