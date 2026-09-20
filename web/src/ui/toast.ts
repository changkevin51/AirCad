export type ToastKind = 'info' | 'success' | 'error';

/**
 * Exceptional results and errors, stacked in the overlay notification slot.
 * Polite live region; identical messages refresh instead of stacking.
 */
export class Toasts {
  private readonly container: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'toasts';
    this.container.setAttribute('aria-live', 'polite');
    root.appendChild(this.container);
  }

  show(message: string, kind: ToastKind = 'info', durationMs = kind === 'error' ? 4000 : 2200): void {
    // Deduplicate: an identical visible toast just re-arms its timer.
    for (const child of this.container.children) {
      const existing = child as HTMLElement & { timeout?: ReturnType<typeof setTimeout> };
      if (existing.textContent === message && existing.classList.contains(`toast--${kind}`)) {
        clearTimeout(existing.timeout);
        existing.timeout = setTimeout(() => this.dismiss(existing), durationMs);
        return;
      }
    }
    const element = document.createElement('div') as HTMLElement & { timeout?: ReturnType<typeof setTimeout> };
    element.className = `toast toast--${kind}`;
    element.textContent = message;
    this.container.appendChild(element);
    while (this.container.children.length > 3) this.container.firstElementChild?.remove();
    requestAnimationFrame(() => element.classList.add('toast--visible'));
    element.timeout = setTimeout(() => this.dismiss(element), durationMs);
  }

  private dismiss(element: HTMLElement): void {
    element.classList.remove('toast--visible');
    setTimeout(() => element.remove(), 250);
  }
}
