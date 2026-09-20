import { icons } from './icons';
import { applyTheme } from './theme';

export interface WorkspaceRegions {
  appBar: HTMLElement;
  commandBar: HTMLElement;
  modelBrowser: HTMLElement;
  viewControls: HTMLElement;
  viewport: HTMLElement;
  viewportOverlay: HTMLElement;
  inspector: HTMLElement;
  input: HTMLElement;
  cameraPreview: HTMLElement;
  statusBar: HTMLElement;
  notifications: HTMLElement;
  dialogs: HTMLElement;
}

export type InspectorTab = 'properties' | 'input';

export interface WorkspaceLayout {
  browserVisible: boolean;
  inspectorVisible: boolean;
  inspectorTab: InspectorTab;
}

export const LAYOUT_STORAGE_KEY = 'aircad.ui.layout.v1';

const DEFAULT_LAYOUT: WorkspaceLayout = {
  browserVisible: true,
  inspectorVisible: true,
  inspectorTab: 'properties',
};

type PanelBand = 'normal' | 'compact' | 'narrow';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/** Read the persisted layout preference; storage failures are silent. */
export function loadLayoutPrefs(storage: StorageLike = globalThis.localStorage): WorkspaceLayout {
  try {
    const raw = storage?.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const data = JSON.parse(raw) as Partial<WorkspaceLayout>;
    return {
      browserVisible: typeof data.browserVisible === 'boolean' ? data.browserVisible : DEFAULT_LAYOUT.browserVisible,
      inspectorVisible: typeof data.inspectorVisible === 'boolean' ? data.inspectorVisible : DEFAULT_LAYOUT.inspectorVisible,
      inspectorTab: data.inspectorTab === 'input' ? 'input' : 'properties',
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Persist the layout preference; storage failures are silent. */
export function saveLayoutPrefs(layout: WorkspaceLayout, storage: StorageLike = globalThis.localStorage): void {
  try {
    storage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* storage may be unavailable */
  }
}

/**
 * Effective panel visibility for a width band.  `compact` (1024–1279 px)
 * collapses the browser by default and allows only one open side; `narrow`
 * (<1024 px) is a single user-invoked drawer.  `open` is the side the user
 * last opened inside the band (transient, not persisted).
 */
export function resolvePanelVisibility(
  prefs: WorkspaceLayout,
  band: PanelBand,
  open: 'browser' | 'inspector' | null,
): Pick<WorkspaceLayout, 'browserVisible' | 'inspectorVisible'> {
  if (band === 'normal') {
    return { browserVisible: prefs.browserVisible, inspectorVisible: prefs.inspectorVisible };
  }
  const side = open ?? (band === 'compact' && prefs.inspectorVisible ? 'inspector' : null);
  return { browserVisible: side === 'browser', inspectorVisible: side === 'inspector' };
}

const INSPECTOR_TABS: { id: InspectorTab; label: string }[] = [
  { id: 'properties', label: 'Properties' },
  { id: 'input', label: 'Input' },
];

/**
 * Owns the fixed application chrome regions: grid rows for the app bar,
 * command bar, docked side panels around a clipped viewport host, and the
 * status bar.  Region contents are mounted by App; the shell only manages
 * layout, panel visibility, inspector tabs, and F6 region cycling.
 */
export class WorkspaceShell {
  readonly regions: WorkspaceRegions;
  private prefs: WorkspaceLayout;
  private band: PanelBand = 'normal';
  private bandOpen: 'browser' | 'inspector' | null = null;
  private readonly layoutListeners = new Set<() => void>();
  private readonly browserPanel: HTMLElement;
  private readonly inspectorPanel: HTMLElement;
  private readonly browserCount: HTMLElement;
  private readonly tabButtons = new Map<InspectorTab, HTMLButtonElement>();
  private readonly tabBodies = new Map<InspectorTab, HTMLElement>();
  private readonly mediaQueries: MediaQueryList[] = [];

  constructor(private readonly root: HTMLElement) {
    applyTheme(root);
    root.classList.add('workspace');
    this.prefs = loadLayoutPrefs();

    const appBar = el('header', 'ws-app-bar');
    const commandBar = el('div', 'ws-command-bar');
    const main = el('div', 'ws-main');
    const statusBar = el('footer', 'ws-status-bar');
    const viewChrome = [appBar, commandBar, statusBar];
    for (const chrome of viewChrome) chrome.setAttribute('data-cad-ui', '');

    this.browserPanel = panel('Model');
    this.browserCount = document.createElement('span');
    this.browserCount.className = 'ws-panel__count';
    this.browserPanel.querySelector('.ws-panel__title')?.after(this.browserCount);
    const modelBrowser = body(this.browserPanel);
    modelBrowser.classList.add('ws-browser__body');
    this.browserPanel.querySelector<HTMLButtonElement>('.ws-panel__close')?.addEventListener('click', () => {
      this.setLayout({ browserVisible: false });
    });

    this.inspectorPanel = panel('Inspector');
    this.inspectorPanel.querySelector<HTMLButtonElement>('.ws-panel__close')?.addEventListener('click', () => {
      this.setLayout({ inspectorVisible: false });
    });
    const tabs = this.buildInspectorTabs();
    this.inspectorPanel.querySelector('.ws-panel__title')?.replaceWith(tabs);
    const inspector = document.createElement('div');
    inspector.className = 'ws-panel__body ws-inspector__body';
    inspector.id = 'ws-tab-properties';
    inspector.setAttribute('role', 'tabpanel');
    const input = document.createElement('div');
    input.className = 'ws-panel__body ws-inspector__body';
    input.id = 'ws-tab-input';
    input.setAttribute('role', 'tabpanel');
    const inspectorScroll = el('div', 'ws-inspector__scroll');
    inspectorScroll.append(inspector, input);
    const cameraPreview = el('div', 'ws-camera-slot');
    this.inspectorPanel.append(inspectorScroll, cameraPreview);
    this.tabBodies.set('properties', inspector);
    this.tabBodies.set('input', input);

    const center = el('div', 'ws-center');
    const viewControls = el('div', 'ws-view-header');
    viewControls.setAttribute('data-cad-ui', '');
    const host = el('div', 'ws-viewport-host');
    const viewport = el('div', 'viewport');
    viewport.tabIndex = 0;
    const overlay = el('div', 'ws-viewport-overlay');
    const notifications = el('div', 'ws-notifications');
    overlay.appendChild(notifications);
    host.append(viewport, overlay);
    center.append(viewControls, host);

    main.append(this.browserPanel, center, this.inspectorPanel);
    const dialogs = el('div', 'ws-dialogs');
    dialogs.setAttribute('data-cad-ui', '');
    root.append(appBar, commandBar, main, statusBar, dialogs);

    this.regions = {
      appBar,
      commandBar,
      modelBrowser,
      viewControls,
      viewport,
      viewportOverlay: overlay,
      inspector,
      input,
      cameraPreview,
      statusBar,
      notifications,
      dialogs,
    };

    root.addEventListener('keydown', (event) => {
      if (event.code !== 'F6') return;
      event.preventDefault();
      this.cycleRegion(event.shiftKey ? -1 : 1);
    });

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const compact = window.matchMedia('(min-width: 1024px) and (max-width: 1279px)');
      const narrow = window.matchMedia('(max-width: 1023px)');
      this.mediaQueries.push(compact, narrow);
      const onBandChange = () => this.applyBand(compact.matches ? 'compact' : narrow.matches ? 'narrow' : 'normal');
      compact.addEventListener?.('change', onBandChange);
      narrow.addEventListener?.('change', onBandChange);
      onBandChange();
    } else {
      this.apply();
    }
  }

  get layout(): WorkspaceLayout {
    const panels = resolvePanelVisibility(this.prefs, this.band, this.bandOpen);
    return { ...panels, inspectorTab: this.prefs.inspectorTab };
  }

  onLayoutChange(listener: () => void): () => void {
    this.layoutListeners.add(listener);
    return () => this.layoutListeners.delete(listener);
  }

  setLayout(partial: Partial<WorkspaceLayout>): void {
    const before = this.layout;
    if (partial.inspectorTab) this.prefs.inspectorTab = partial.inspectorTab;
    if (this.band === 'normal') {
      if (partial.browserVisible !== undefined) this.prefs.browserVisible = partial.browserVisible;
      if (partial.inspectorVisible !== undefined) this.prefs.inspectorVisible = partial.inspectorVisible;
    } else {
      // Compact/narrow bands keep one side open at a time and stay transient.
      if (partial.browserVisible === true) this.bandOpen = 'browser';
      else if (partial.inspectorVisible === true) this.bandOpen = 'inspector';
      else if (partial.browserVisible === false && this.bandOpen === 'browser') this.bandOpen = null;
      else if (partial.inspectorVisible === false && this.bandOpen === 'inspector') this.bandOpen = null;
    }
    saveLayoutPrefs(this.prefs);
    this.apply();
    const after = this.layout;
    if (before.browserVisible !== after.browserVisible || before.inspectorVisible !== after.inspectorVisible) {
      for (const listener of this.layoutListeners) listener();
    }
  }

  /** Total entity count shown next to the Model header. */
  setEntityCount(count: number): void {
    this.browserCount.textContent = String(count);
  }

  private buildInspectorTabs(): HTMLElement {
    const list = el('div', 'ws-tabs');
    list.setAttribute('role', 'tablist');
    for (const tab of INSPECTOR_TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ws-tab';
      button.id = `ws-tabbtn-${tab.id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `ws-tab-${tab.id}`);
      button.textContent = tab.label;
      button.addEventListener('click', () => this.setLayout({ inspectorTab: tab.id }));
      button.addEventListener('keydown', (event) => {
        if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return;
        event.preventDefault();
        const index = INSPECTOR_TABS.findIndex((t) => t.id === tab.id);
        const next = INSPECTOR_TABS[(index + (event.code === 'ArrowRight' ? 1 : INSPECTOR_TABS.length - 1)) % INSPECTOR_TABS.length];
        this.setLayout({ inspectorTab: next.id });
        this.tabButtons.get(next.id)?.focus();
      });
      list.appendChild(button);
      this.tabButtons.set(tab.id, button);
    }
    return list;
  }

  private applyBand(band: PanelBand): void {
    const changed = band !== this.band;
    const before = this.layout;
    this.band = band;
    if (changed) this.bandOpen = null;
    this.apply();
    const after = this.layout;
    if (before.browserVisible !== after.browserVisible || before.inspectorVisible !== after.inspectorVisible) {
      for (const listener of this.layoutListeners) listener();
    }
  }

  private apply(): void {
    const layout = this.layout;
    this.root.classList.toggle('ws--narrow', this.band === 'narrow');
    this.browserPanel.classList.toggle('hidden', !layout.browserVisible);
    this.inspectorPanel.classList.toggle('hidden', !layout.inspectorVisible);
    for (const tab of INSPECTOR_TABS) {
      const active = layout.inspectorTab === tab.id;
      const button = this.tabButtons.get(tab.id);
      const bodyEl = this.tabBodies.get(tab.id);
      button?.setAttribute('aria-selected', String(active));
      button?.classList.toggle('ws-tab--active', active);
      if (button) button.tabIndex = active ? 0 : -1;
      bodyEl?.classList.toggle('hidden', !active);
    }
  }

  /** F6: app commands → browser → viewport → inspector (skipping hidden panels). */
  private cycleRegion(direction: 1 | -1): void {
    const layout = this.layout;
    const targets: HTMLElement[] = [this.regions.appBar];
    if (layout.browserVisible) targets.push(this.browserPanel);
    targets.push(this.regions.viewport);
    if (layout.inspectorVisible) targets.push(this.inspectorPanel);
    const active = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    const current = targets.findIndex((region) => region === active || region.contains?.(active));
    const next = targets[(current + direction + targets.length) % targets.length] ?? targets[0];
    this.focusRegion(next);
  }

  private focusRegion(region: HTMLElement): void {
    const focusable =
      region === this.regions.viewport
        ? region
        : region.querySelector<HTMLElement>('button, select, input, [tabindex]') ?? region;
    focusable.focus();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

/** A docked side panel: header with title + close control, body appended by callers. */
function panel(title: string): HTMLElement {
  const aside = el('aside', 'ws-panel');
  aside.setAttribute('data-cad-ui', '');
  const header = el('div', 'ws-panel__header');
  const titleEl = el('span', 'ws-panel__title');
  titleEl.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ws-iconbtn';
  close.innerHTML = icons.close;
  close.setAttribute('aria-label', `Close ${title} panel`);
  close.title = `Close ${title} panel`;
  header.append(titleEl, close);
  aside.appendChild(header);
  return aside;
}

function body(panelElement: HTMLElement): HTMLElement {
  const bodyEl = el('div', 'ws-panel__body');
  panelElement.appendChild(bodyEl);
  return bodyEl;
}
