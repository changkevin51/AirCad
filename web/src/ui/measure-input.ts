import { openDialog, type DialogHandle } from './dialog';
import type { UiActionResult } from './workspace-state';

/**
 * Compact exact-entry dialog for typed measurements (stand-in for voice).
 * `onSubmit` returns a UiActionResult: `{ok:false}` keeps the dialog open
 * with the inline error and the draft; `{ok:true}`/void closes it.
 */
export class MeasureInput {
  private readonly form: HTMLFormElement;
  private readonly label: HTMLLabelElement;
  private readonly input: HTMLInputElement;
  private readonly error: HTMLDivElement;
  private dialog: DialogHandle | null = null;
  private onSubmit: ((text: string) => UiActionResult | void) | null = null;
  private onClose: (() => void) | null = null;

  constructor(private readonly host: HTMLElement) {
    this.form = document.createElement('form');
    this.form.className = 'measure-form';
    this.form.noValidate = true;
    this.label = document.createElement('label');
    this.label.htmlFor = 'measure-input';
    this.input = document.createElement('input');
    this.input.id = 'measure-input';
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = '4000 or 4000x3000';
    this.error = document.createElement('div');
    this.error.className = 'insp-error';
    this.error.id = 'measure-error';
    this.error.setAttribute('role', 'alert');
    this.form.append(this.label, this.input, this.error);

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
  }

  get isOpen(): boolean {
    return this.dialog !== null;
  }

  open(label: string, onSubmit: (text: string) => UiActionResult | void, onClose?: () => void, initialValue?: string): void {
    this.close();
    this.label.textContent = label;
    this.onSubmit = onSubmit;
    this.onClose = onClose ?? null;
    this.input.value = initialValue ?? '';
    this.error.textContent = '';
    this.input.removeAttribute('aria-invalid');
    this.input.removeAttribute('aria-describedby');
    this.dialog = openDialog({
      host: this.host,
      title: 'Exact value',
      body: this.form,
      initialFocus: this.input,
      backdropClose: true,
      actions: [
        {
          label: 'Apply',
          tone: 'primary',
          onClick: () => {
            if (!this.submit()) return false;
          },
        },
        { label: 'Cancel', onClick: () => undefined },
      ],
      onClose: () => this.closed(),
    });
    this.input.focus();
    if (initialValue) this.input.select();
  }

  /** Submit the current text; a failed result keeps the dialog open. */
  private submit(): boolean {
    const submit = this.onSubmit;
    if (!submit) return true;
    const result = submit(this.input.value.trim());
    if (result && !result.ok) {
      this.error.textContent = result.error;
      this.input.setAttribute('aria-invalid', 'true');
      this.input.setAttribute('aria-describedby', this.error.id);
      this.input.focus();
      return false;
    }
    this.error.textContent = '';
    return true;
  }

  close(): void {
    this.dialog?.close();
  }

  private closed(): void {
    this.dialog = null;
    this.onSubmit = null;
    const onClose = this.onClose;
    this.onClose = null;
    onClose?.();
  }
}
