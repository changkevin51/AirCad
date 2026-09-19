export type ToastKind = 'info' | 'success' | 'error';

/** Stacked, auto-dismissing notifications in the top-right corner. */
export class Toasts {
  private readonly container: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'toasts';
    root.appendChild(this.container);
  }

  show(message: string, kind: ToastKind = 'info', durationMs = kind === 'error' ? 4000 : 2200): void {
    const element = document.createElement('div');
    element.className = `toast toast--${kind}`;
    element.textContent = message;
    this.container.appendChild(element);
    while (this.container.children.length > 4) this.container.firstElementChild?.remove();
    requestAnimationFrame(() => element.classList.add('toast--visible'));
    setTimeout(() => {
      element.classList.remove('toast--visible');
      setTimeout(() => element.remove(), 250);
    }, durationMs);
  }
}
