import type { Entity } from '../model/sketch';
import { icons } from './icons';
import { entityLabel, EXTRUSION_FIRST, type UiActionResult, type WorkspaceAction } from './workspace-state';

export interface ModelBrowserCallbacks {
  dispatch(action: WorkspaceAction): UiActionResult;
  /** Routine feedback surface (status-bar flash). */
  flash(text: string, tone?: 'info' | 'success'): void;
}

const ICONS: Record<Entity['type'], string> = {
  line: icons.line,
  rect: icons.rectangle,
  polygon: icons.polygon,
  extrusion: icons.box,
  circle: icons.circle,
};

/**
 * Flat single-select listbox of committed entities.  Rows are reconciled by
 * entity id so DOM nodes survive selection churn; updates arrive from
 * `publishUi`, never per frame.
 */
export class ModelBrowser {
  private readonly list: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly rows = new Map<string, HTMLDivElement>();
  private order: string[] = [];
  private selectedId: string | null = null;
  private extruding = false;

  constructor(host: HTMLElement, private readonly cb: ModelBrowserCallbacks) {
    this.list = document.createElement('div');
    this.list.className = 'ws-listbox';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Model objects');
    this.list.tabIndex = 0;
    this.empty = document.createElement('div');
    this.empty.className = 'ws-stub';
    this.empty.textContent = 'No objects yet.';
    host.append(this.list, this.empty);

    this.list.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  update(entities: readonly Entity[], selectedId: string | null, extruding: boolean): void {
    this.selectedId = selectedId;
    this.extruding = extruding;
    const nextOrder = entities.map((entity) => entity.id);
    const hadFocus = this.list.contains(document.activeElement);
    const activeRowId = (document.activeElement as HTMLElement | null)?.dataset?.id ?? null;

    // Drop rows for entities that no longer exist.
    for (const [id, row] of this.rows) {
      if (!entities.some((entity) => entity.id === id)) {
        row.remove();
        this.rows.delete(id);
      }
    }

    for (const entity of entities) {
      const label = entityLabel(entity);
      let row = this.rows.get(entity.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'ws-row';
        row.setAttribute('role', 'option');
        row.dataset.id = entity.id;
        const icon = document.createElement('span');
        icon.className = 'ws-row__icon';
        const text = document.createElement('span');
        text.className = 'ws-row__label';
        row.append(icon, text);
        row.addEventListener('click', () => {
          row!.focus();
          this.select(entity.id);
        });
        this.rows.set(entity.id, row);
      }
      row.querySelector<HTMLElement>('.ws-row__label')!.textContent = label;
      row.querySelector<HTMLElement>('.ws-row__icon')!.innerHTML = ICONS[entity.type];
      const selected = entity.id === selectedId;
      row.setAttribute('aria-selected', String(selected));
      row.classList.toggle('ws-row--selected', selected);
      if (extruding) {
        row.setAttribute('aria-disabled', 'true');
        row.title = EXTRUSION_FIRST;
      } else {
        row.removeAttribute('aria-disabled');
        row.title = label;
      }
    }

    // Reorder rows to match entity order without rebuilding nodes — but only
    // when the order actually changed: appendChild disconnects a focused row
    // for a moment and the browser drops its focus to <body>.
    const orderChanged =
      this.order.length !== nextOrder.length || this.order.some((id, index) => id !== nextOrder[index]);
    this.order = nextOrder;
    if (orderChanged) for (const id of nextOrder) this.list.appendChild(this.rows.get(id)!);

    // Roving tabindex: the selected row (or the first) is the tab stop.
    const roving = selectedId && this.rows.has(selectedId) ? selectedId : nextOrder[0] ?? null;
    for (const [id, row] of this.rows) row.tabIndex = id === roving ? 0 : -1;

    // Keep focus inside the list when the focused row disappeared or a reorder
    // blurred it.
    if (hadFocus && !this.list.contains(document.activeElement)) {
      const fallback = (activeRowId ? this.rows.get(activeRowId) : undefined) ?? this.rows.get(roving ?? '') ?? null;
      (fallback ?? this.list).focus();
    }

    this.empty.classList.toggle('hidden', entities.length > 0);
    this.list.classList.toggle('hidden', entities.length === 0);
  }

  private select(id: string | null): void {
    if (this.extruding) return;
    const result = this.cb.dispatch({ type: 'selectEntity', id });
    if (!result.ok) this.cb.flash(result.error);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.id ?? null;
    const currentIndex = focusedId ? this.order.indexOf(focusedId) : this.order.indexOf(this.selectedId ?? '');
    const move = (index: number) => {
      const id = this.order[Math.max(0, Math.min(this.order.length - 1, index))];
      if (id === undefined) return;
      this.rows.get(id)?.focus();
      this.select(id);
    };
    // Handled keys stop here: the dispatch may remove the event target from the
    // DOM, after which the app's chrome check can no longer see it came from a
    // [data-cad-ui] region and would run the CAD shortcut a second time.
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.code) {
      case 'ArrowDown':
        handled();
        move(currentIndex + 1);
        break;
      case 'ArrowUp':
        handled();
        move(currentIndex - 1);
        break;
      case 'Home':
        handled();
        move(0);
        break;
      case 'End':
        handled();
        move(this.order.length - 1);
        break;
      case 'Enter':
      case 'Space':
        if (focusedId) {
          handled();
          this.select(focusedId);
        }
        break;
      case 'Delete':
      case 'Backspace': {
        // Only ever deletes the focused/selected row's entity.
        const id = focusedId ?? this.selectedId;
        if (!id || this.extruding) return;
        handled();
        if (id !== this.selectedId) this.select(id);
        if (this.selectedId !== id) return;
        const result = this.cb.dispatch({ type: 'press', action: 'delete' });
        if (!result.ok) this.cb.flash(result.error);
        break;
      }
    }
  }
}
