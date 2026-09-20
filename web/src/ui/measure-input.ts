/** Inline text input at the status bar for typed measurements (stand-in for voice). */
export class MeasureInput {
  private readonly form: HTMLFormElement;
  private readonly label: HTMLLabelElement;
  private readonly input: HTMLInputElement;
  private onSubmit: ((text: string) => void) | null = null;
  private onClose: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.form = document.createElement('form');
    this.form.className = 'measure hidden';
    this.label = document.createElement('label');
    this.label.htmlFor = 'measure-input';
    this.input = document.createElement('input');
    this.input.id = 'measure-input';
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = '4000 or 4000x3000';
    const hint = document.createElement('span');
    hint.className = 'measure__hint';
    hint.innerHTML = '<kbd>Enter</kbd> apply <kbd>Esc</kbd> cancel';
    this.form.append(this.label, this.input, hint);
    root.appendChild(this.form);

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      const submit = this.onSubmit;
      this.close();
      if (text && submit) submit(text);
    });
    this.input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.form.requestSubmit();
      }
    });
    this.input.addEventListener('keyup', (event) => event.stopPropagation());
  }

  get isOpen(): boolean {
    return !this.form.classList.contains('hidden');
  }

  open(label: string, onSubmit: (text: string) => void, onClose?: () => void, initialValue?: string): void {
    this.label.textContent = label;
    this.onSubmit = onSubmit;
    this.onClose = onClose ?? null;
    this.input.value = initialValue ?? '';
    this.form.classList.remove('hidden');
    this.input.focus();
    if (initialValue) this.input.select();
  }

  close(): void {
    if (!this.isOpen) return;
    this.form.classList.add('hidden');
    this.input.blur();
    this.onSubmit = null;
    const onClose = this.onClose;
    this.onClose = null;
    onClose?.();
  }
}
