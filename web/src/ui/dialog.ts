/**
 * Shared accessible dialog: `role="dialog"`, `aria-modal`, labelled by its
 * title, Tab/Shift+Tab containment, Escape to close, and focus restoration
 * to whatever was focused before it opened.  Backdrop clicks close only
 * when `backdropClose` is set — destructive dialogs keep the explicit
 * Cancel path instead.
 */
export interface DialogAction {
  label: string;
  /** Visual tone; 'danger' marks destructive commits. */
  tone?: 'primary' | 'danger' | 'default';
  /** This action's button receives initial focus (e.g. Cancel on a confirm). */
  focus?: boolean;
  /** Returning false keeps the dialog open (e.g. invalid input). */
  onClick(): boolean | void;
}

export interface DialogOptions {
  /** Container the backdrop is mounted into (the shell's dialogs region). */
  host: HTMLElement;
  title: string;
  body: HTMLElement;
  actions?: DialogAction[];
  /** Element to focus on open; defaults to the first focusable descendant. */
  initialFocus?: HTMLElement;
  /** Backdrop click dismisses the dialog. Off for destructive dialogs. */
  backdropClose?: boolean;
  /** 'wide' suits multi-pane content such as the sectioned help. */
  size?: 'compact' | 'wide';
  onClose?: () => void;
}

export interface DialogHandle {
  readonly backdrop: HTMLElement;
  readonly panel: HTMLElement;
  close(): void;
}

let nextDialogId = 0;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function openDialog(options: DialogOptions): DialogHandle {
  const previous = document.activeElement as HTMLElement | null;

  const backdrop = document.createElement('div');
  backdrop.className = 'ws-dialog-backdrop';
  backdrop.setAttribute('data-cad-ui', '');

  const panel = document.createElement('div');
  panel.className = `ws-dialog${options.size === 'wide' ? ' ws-dialog--wide' : ''}`;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const titleId = `ws-dialog-${++nextDialogId}-title`;
  panel.setAttribute('aria-labelledby', titleId);

  const header = document.createElement('div');
  header.className = 'ws-dialog__head';
  const title = document.createElement('h2');
  title.id = titleId;
  title.textContent = options.title;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'ws-iconbtn';
  dismiss.setAttribute('aria-label', 'Close');
  dismiss.title = 'Close (Esc)';
  dismiss.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  dismiss.addEventListener('click', () => handle.close());
  header.append(title, dismiss);

  const body = document.createElement('div');
  body.className = 'ws-dialog__body';
  body.appendChild(options.body);

  panel.append(header, body);

  let actionFocus: HTMLElement | null = null;
  if (options.actions?.length) {
    const row = document.createElement('div');
    row.className = 'ws-dialog__actions';
    for (const action of options.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ws-btn${action.tone && action.tone !== 'default' ? ` ws-btn--${action.tone}` : ''}`;
      button.textContent = action.label;
      button.addEventListener('click', () => {
        if (action.onClick() === false) return;
        handle.close();
      });
      if (action.focus) actionFocus = button;
      row.appendChild(button);
    }
    panel.appendChild(row);
  }

  backdrop.appendChild(panel);

  const close = () => {
    if (!backdrop.isConnected && !backdrop.parentNode) return;
    backdrop.remove();
    if (previous && document.contains(previous)) previous.focus();
    options.onClose?.();
  };

  const handle: DialogHandle = { backdrop, panel, close };

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop && options.backdropClose) handle.close();
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      handle.close();
      return;
    }
    if (event.code !== 'Tab') return;
    // Contain Tab/Shift+Tab inside the dialog.
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true',
    );
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  options.host.appendChild(backdrop);
  const initial = options.initialFocus ?? actionFocus ?? panel.querySelector<HTMLElement>(FOCUSABLE);
  (initial ?? panel).focus?.();
  return handle;
}
