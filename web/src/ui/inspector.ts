import { parseDepth, parseDimensionSpec } from '../model/commands';
import {
  formatMm,
  isExtrudableProfile,
  isRectangleProfile,
  lineLength,
  rectFrame,
  type Entity,
} from '../model/sketch';
import { icons } from './icons';
import {
  entityLabel,
  type ExtrusionSnapshot,
  type UiActionResult,
  type UiSnapshot,
  type WorkspaceAction,
} from './workspace-state';

export interface InspectorCallbacks {
  dispatch(action: WorkspaceAction): UiActionResult;
  flash(text: string, tone?: 'info' | 'success'): void;
}

const ICONS: Record<Entity['type'], string> = {
  line: icons.line,
  rect: icons.rectangle,
  polygon: icons.polygon,
  extrusion: icons.box,
  triangle: icons.triangle,
  prism: icons.box,
  circle: icons.circle,
};

let nextFieldId = 0;

function field(label: string, input: HTMLInputElement): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'insp-field';
  const text = document.createElement('span');
  text.textContent = label;
  input.id = `insp-field-${++nextFieldId}`;
  wrap.append(text, input);
  return wrap;
}

function makeInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.inputMode = 'decimal';
  return input;
}

const trimNumber = (value: number): string => String(Number(value.toFixed(6)));

/**
 * Properties tab: per-entity dimension forms and the Push/Pull operation
 * surface.  Static DOM toggled in place; field drafts are only cleared by
 * submit, Escape, or a selection change — never by a frame update.
 */
export class Inspector {
  private readonly empty: HTMLElement;
  private readonly entitySection: HTMLElement;
  private readonly opSection: HTMLElement;
  private readonly entityIcon: HTMLElement;
  private readonly entityTitle: HTMLElement;
  private readonly entityNote: HTMLElement;

  private readonly lengthForm: HTMLFormElement;
  private readonly lengthInput = makeInput();
  private readonly sizeForm: HTMLFormElement;
  private readonly widthInput = makeInput();
  private readonly heightInput = makeInput();
  private readonly depthForm: HTMLFormElement;
  private readonly depthInput = makeInput();
  private readonly details: HTMLDetailsElement;
  private readonly detailsBody: HTMLElement;
  private readonly pushPullButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;

  private readonly opTarget: HTMLElement;
  private readonly faceSelect: HTMLSelectElement;
  private readonly faceNote: HTMLElement;
  private readonly pullForm: HTMLFormElement;
  private readonly pullInput = makeInput();
  private readonly opDepth: HTMLElement;
  private readonly opBase: HTMLElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;

  private readonly errors = new Map<HTMLFormElement, HTMLElement>();
  private displayed: Entity | null = null;
  private draft: { id: string; entity: Entity } | null = null;
  private lastFaceSig = '';
  private lastTargetId: string | null = null;
  /** True while a committed dimension dispatch republishes synchronously. */
  private committing = false;

  constructor(host: HTMLElement, private readonly cb: InspectorCallbacks) {
    const root = document.createElement('div');
    root.className = 'insp';

    // --- no selection -----------------------------------------------------
    this.empty = document.createElement('div');
    this.empty.className = 'insp-empty';
    const emptyText = document.createElement('p');
    emptyText.className = 'insp-text';
    emptyText.textContent = 'Select an object to inspect its dimensions.';
    const meta = document.createElement('dl');
    meta.className = 'insp-meta';
    const unitsLabel = document.createElement('dt');
    unitsLabel.textContent = 'Units';
    const unitsValue = document.createElement('dd');
    unitsValue.textContent = 'mm';
    const planeLabel = document.createElement('dt');
    planeLabel.textContent = 'Work plane';
    const planeValue = document.createElement('dd');
    planeValue.dataset.role = 'plane';
    meta.append(unitsLabel, unitsValue, planeLabel, planeValue);
    const hint = document.createElement('p');
    hint.className = 'insp-hint';
    hint.textContent = 'Left-drag or hold Space to draw. Click to select.';
    this.empty.append(emptyText, meta, hint);
    this.emptyPlane = planeValue;

    // --- entity form ------------------------------------------------------
    this.entitySection = document.createElement('div');
    this.entitySection.className = 'insp-entity';
    const head = document.createElement('div');
    head.className = 'insp-head';
    this.entityIcon = document.createElement('span');
    this.entityIcon.className = 'insp-head__icon';
    this.entityTitle = document.createElement('h3');
    this.entityTitle.className = 'insp-head__title';
    head.append(this.entityIcon, this.entityTitle);
    this.entityNote = document.createElement('div');
    this.entityNote.className = 'insp-note hidden';
    this.entityNote.textContent = 'Object changed; edit again.';

    this.lengthForm = this.form('length');
    this.lengthForm.append(field('Length (mm)', this.lengthInput), this.errorFor(this.lengthForm), this.submitButton('Apply length'));
    this.lengthForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const parsed = parseDimensionSpec(this.lengthInput.value);
      if (!parsed || parsed.length === undefined) {
        this.fail(this.lengthForm, 'Length: enter a size like 4000, 5 m, or 300 cm.', [this.lengthInput]);
        return;
      }
      this.commitDimension(this.lengthForm, [this.lengthInput], this.lengthInput.value);
    });

    this.sizeForm = this.form('size');
    this.sizeForm.append(
      field('Width (mm)', this.widthInput),
      field('Height (mm)', this.heightInput),
      this.errorFor(this.sizeForm),
      this.submitButton('Apply size'),
    );
    this.sizeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const width = parseDimensionSpec(this.widthInput.value);
      if (!width || width.length === undefined) {
        this.fail(this.sizeForm, 'Width: enter a size like 4000, 5 m, or 300 cm.', [this.widthInput]);
        return;
      }
      const height = parseDimensionSpec(this.heightInput.value);
      if (!height || height.length === undefined) {
        this.fail(this.sizeForm, 'Height: enter a size like 4000, 5 m, or 300 cm.', [this.heightInput]);
        return;
      }
      this.commitDimension(this.sizeForm, [this.widthInput, this.heightInput], `${this.widthInput.value.trim()} x ${this.heightInput.value.trim()}`);
    });

    this.depthForm = this.form('depth');
    this.depthForm.append(field('Depth (mm, signed)', this.depthInput), this.errorFor(this.depthForm), this.submitButton('Apply depth'));
    this.depthForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (parseDepth(this.depthInput.value) === null) {
        this.fail(this.depthForm, 'Depth: enter a non-zero distance such as 500, -250, or 2 m.', [this.depthInput]);
        return;
      }
      this.commitDimension(this.depthForm, [this.depthInput], this.depthInput.value);
    });

    this.details = document.createElement('details');
    this.details.className = 'insp-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    this.detailsBody = document.createElement('div');
    this.detailsBody.className = 'insp-details__body';
    this.details.append(summary, this.detailsBody);

    const actions = document.createElement('div');
    actions.className = 'insp-actions';
    this.pushPullButton = document.createElement('button');
    this.pushPullButton.type = 'button';
    this.pushPullButton.className = 'ws-btn';
    this.pushPullButton.textContent = 'Push/Pull';
    this.pushPullButton.title = 'Push/pull the selected rectangle or box (Q)';
    this.pushPullButton.addEventListener('click', () => this.press('extrude'));
    this.deleteButton = document.createElement('button');
    this.deleteButton.type = 'button';
    this.deleteButton.className = 'ws-btn ws-btn--danger';
    this.deleteButton.textContent = 'Delete';
    this.deleteButton.title = 'Delete the selected object (Del)';
    this.deleteButton.addEventListener('click', () => this.press('delete'));
    actions.append(this.pushPullButton, this.deleteButton);

    this.entitySection.append(head, this.entityNote, this.lengthForm, this.sizeForm, this.depthForm, this.details, actions);

    // --- Push/Pull operation ----------------------------------------------
    this.opSection = document.createElement('div');
    this.opSection.className = 'insp-extrude';
    const opHead = document.createElement('div');
    opHead.className = 'insp-head';
    const opTitle = document.createElement('h3');
    opTitle.className = 'insp-head__title';
    opTitle.textContent = 'Push/Pull';
    opHead.appendChild(opTitle);
    this.opTarget = document.createElement('div');
    this.opTarget.className = 'insp-target';

    const faceWrap = document.createElement('label');
    faceWrap.className = 'insp-field';
    const faceText = document.createElement('span');
    faceText.textContent = 'Face';
    this.faceSelect = document.createElement('select');
    faceWrap.append(faceText, this.faceSelect);
    this.faceSelect.addEventListener('change', () => {
      const index = Number(this.faceSelect.value);
      const result = this.cb.dispatch({ type: 'setExtrusionFace', index });
      if (!result.ok) this.fail(this.pullForm, result.error);
    });
    this.faceNote = document.createElement('div');
    this.faceNote.className = 'insp-hint';
    this.faceNote.textContent = 'Release to switch faces.';

    this.pullForm = this.form('pull');
    this.pullInput.placeholder = '500 or -250';
    this.pullForm.append(
      field('Pull distance (mm, signed)', this.pullInput),
      this.errorFor(this.pullForm),
      this.submitButton('Update preview'),
    );
    this.pullForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const result = this.cb.dispatch({ type: 'setExtrusionPull', text: this.pullInput.value });
      if (!result.ok) {
        this.fail(this.pullForm, result.error);
        return;
      }
      this.clearError(this.pullForm);
      delete this.pullInput.dataset.dirty;
    });

    const readout = document.createElement('dl');
    readout.className = 'insp-meta';
    const depthLabel = document.createElement('dt');
    depthLabel.textContent = 'Depth';
    this.opDepth = document.createElement('dd');
    const baseLabel = document.createElement('dt');
    baseLabel.textContent = 'Base';
    this.opBase = document.createElement('dd');
    readout.append(depthLabel, this.opDepth, baseLabel, this.opBase);

    const opActions = document.createElement('div');
    opActions.className = 'insp-actions';
    this.applyButton = document.createElement('button');
    this.applyButton.type = 'button';
    this.applyButton.className = 'ws-btn ws-btn--primary';
    this.applyButton.textContent = 'Apply';
    this.applyButton.addEventListener('click', () => this.press('confirm'));
    this.cancelButton = document.createElement('button');
    this.cancelButton.type = 'button';
    this.cancelButton.className = 'ws-btn';
    this.cancelButton.textContent = 'Cancel';
    this.cancelButton.addEventListener('click', () => this.press('cancel'));
    opActions.append(this.applyButton, this.cancelButton);

    this.opSection.append(opHead, this.opTarget, faceWrap, this.faceNote, this.pullForm, readout, opActions);

    root.append(this.empty, this.entitySection, this.opSection);
    host.appendChild(root);

    for (const input of [this.lengthInput, this.widthInput, this.heightInput, this.depthInput, this.pullInput]) {
      input.addEventListener('input', () => {
        input.dataset.dirty = '1';
        if (this.displayed) this.draft = { id: this.displayed.id, entity: this.displayed };
      });
      input.addEventListener('keydown', (event) => {
        if (event.code === 'Escape') {
          event.preventDefault();
          delete input.dataset.dirty;
          const form = input.closest('form');
          if (form) this.clearError(form as HTMLFormElement);
          this.reloadFields();
          input.blur();
        }
      });
    }
  }

  private emptyPlane: HTMLElement;

  private form(name: string): HTMLFormElement {
    const form = document.createElement('form');
    form.className = 'insp-form';
    form.dataset.form = name;
    form.noValidate = true;
    return form;
  }

  private errorFor(form: HTMLFormElement): HTMLElement {
    const error = document.createElement('div');
    error.className = 'insp-error';
    error.id = `insp-error-${form.dataset.form}`;
    error.setAttribute('role', 'alert');
    this.errors.set(form, error);
    return error;
  }

  private submitButton(label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'ws-btn ws-btn--primary';
    button.textContent = label;
    return button;
  }

  /** Mark just the offending field(s); the error text names the field. */
  private fail(form: HTMLFormElement, message: string, offenders?: HTMLInputElement[]): void {
    const error = this.errors.get(form);
    if (error) error.textContent = message;
    for (const input of form.querySelectorAll('input')) {
      const bad = !offenders || offenders.includes(input);
      if (bad) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', error?.id ?? '');
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
    }
  }

  private clearError(form: HTMLFormElement): void {
    const error = this.errors.get(form);
    if (error) error.textContent = '';
    for (const input of form.querySelectorAll('input')) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }

  private press(action: 'extrude' | 'confirm' | 'cancel' | 'delete'): void {
    const result = this.cb.dispatch({ type: 'press', action });
    if (!result.ok) this.cb.flash(result.error);
  }

  private commitDimension(form: HTMLFormElement, fields: HTMLInputElement[], spec: string): void {
    const entity = this.displayed;
    if (!entity) return;
    // A successful commit republishes synchronously.  Clear the draft and
    // suppress the dirty check first so update() reloads the normalized
    // model values instead of flagging our own Apply as an external change
    // or keeping the raw typed text because the input is still focused.
    const savedDirty = fields.map((input) => input.dataset.dirty);
    const savedDraft = this.draft;
    this.draft = null;
    for (const input of fields) delete input.dataset.dirty;
    this.committing = true;
    const result = this.cb.dispatch({ type: 'setDimension', id: entity.id, spec });
    this.committing = false;
    if (!result.ok) {
      this.draft = savedDraft;
      fields.forEach((input, index) => {
        if (savedDirty[index]) input.dataset.dirty = savedDirty[index];
      });
      this.fail(form, result.error);
      return;
    }
    this.clearError(form);
  }

  private reloadFields(): void {
    const entity = this.displayed;
    if (!entity) return;
    if (entity.type === 'line') {
      this.lengthInput.value = trimNumber(lineLength(entity));
    } else if (entity.type !== 'circle' && isRectangleProfile(entity.corners)) {
      const { width, height } = rectFrame(entity);
      this.widthInput.value = trimNumber(width);
      this.heightInput.value = trimNumber(height);
      if (entity.type === 'extrusion') this.depthInput.value = trimNumber(entity.depth);
    } else if (entity.type === 'extrusion' || entity.type === 'prism') {
      this.depthInput.value = trimNumber(entity.depth);
    }
  }

  private dirty(input: HTMLInputElement): boolean {
    if (this.committing) return false;
    return input.dataset.dirty === '1' || document.activeElement === input;
  }

  update(snapshot: UiSnapshot): void {
    const extrusion = snapshot.extrusion;
    const entity = extrusion ? null : snapshot.selected;

    // A new operation target (or leaving Push/Pull) resets the pull draft
    // and face list so stale input never leaks between sessions.
    const targetId = extrusion?.targetId ?? null;
    if (targetId !== this.lastTargetId) {
      this.lastTargetId = targetId;
      this.lastFaceSig = '';
      delete this.pullInput.dataset.dirty;
      this.clearError(this.pullForm);
    }

    this.empty.classList.toggle('hidden', !!entity || !!extrusion);
    this.entitySection.classList.toggle('hidden', !entity || !!extrusion);
    this.opSection.classList.toggle('hidden', !extrusion);

    if (!extrusion) {
      const clearDirty = () => {
        this.draft = null;
        for (const input of [this.lengthInput, this.widthInput, this.heightInput, this.depthInput]) delete input.dataset.dirty;
      };
      if (this.draft && entity && this.draft.id === entity.id && this.draft.entity !== entity) {
        // Same id, new object: reload rather than writing stale values over it.
        clearDirty();
        this.entityNote.classList.remove('hidden');
        setTimeout(() => this.entityNote.classList.add('hidden'), 3000);
      } else if (this.draft && this.draft.id !== entity?.id) {
        // Selection changed: discard the uncommitted draft.
        clearDirty();
      }
      this.displayed = entity;
    }

    if (entity) this.updateEntityForm(entity);
    if (extrusion) this.updateOperation(extrusion);
    this.emptyPlane.textContent = `${snapshot.planeKind} · ${snapshot.planeMode === 'auto' ? 'Auto' : 'Manual'}`;
  }

  private updateEntityForm(entity: Entity): void {
    this.entityIcon.innerHTML = ICONS[entity.type];
    const title = entityLabel(entity);
    if (this.entityTitle.textContent !== title) this.entityTitle.textContent = title;

    const profile = entity.type === 'line' || entity.type === 'circle' ? null : entity;
    const rectangular = !!profile && isRectangleProfile(profile.corners);
    this.lengthForm.classList.toggle('hidden', entity.type !== 'line');
    this.sizeForm.classList.toggle('hidden', !rectangular);
    this.depthForm.classList.toggle('hidden', entity.type !== 'extrusion' && entity.type !== 'prism');
    this.pushPullButton.classList.toggle('hidden', !profile || !isExtrudableProfile(profile.corners));

    if (entity.type === 'line' && !this.dirty(this.lengthInput)) this.fill(this.lengthInput, trimNumber(lineLength(entity)));
    if (profile && rectangular) {
      const { width, height } = rectFrame(profile);
      if (!this.dirty(this.widthInput)) this.fill(this.widthInput, trimNumber(width));
      if (!this.dirty(this.heightInput)) this.fill(this.heightInput, trimNumber(height));
    }
    if ((entity.type === 'extrusion' || entity.type === 'prism') && !this.dirty(this.depthInput)) this.fill(this.depthInput, trimNumber(entity.depth));

    if (entity.type === 'line') {
      const point = (p: { x: number; y: number; z: number }) => `(${trimNumber(p.x)}, ${trimNumber(p.y)}, ${trimNumber(p.z)}) mm`;
      this.detailsBody.textContent = `A ${point(entity.a)} → B ${point(entity.b)}`;
      this.details.classList.remove('hidden');
    } else if (entity.type === 'circle') {
      this.detailsBody.textContent = `Diameter ${trimNumber(entity.radius * 2)} mm · read-only`;
      this.details.classList.remove('hidden');
    } else if (!rectangular) {
      this.detailsBody.textContent = entity.type === 'extrusion' || entity.type === 'prism'
        ? `${entity.corners.length} edges · depth ${trimNumber(entity.depth)} mm`
        : `${entity.corners.length} edges`;
      this.details.classList.remove('hidden');
    } else {
      this.details.classList.add('hidden');
    }
  }

  private updateOperation(extrusion: ExtrusionSnapshot): void {
    const target = `Target: ${extrusion.targetLabel}`;
    if (this.opTarget.textContent !== target) this.opTarget.textContent = target;

    // Rebuild face options only when the real face list changes (2 → 6 when
    // a flat preview becomes a solid).
    const sig = extrusion.faces.map((face) => `${face.index}:${face.label}`).join('|');
    if (sig !== this.lastFaceSig) {
      this.lastFaceSig = sig;
      this.faceSelect.textContent = '';
      for (const face of extrusion.faces) {
        const option = document.createElement('option');
        option.value = String(face.index);
        option.textContent = face.label;
        this.faceSelect.appendChild(option);
      }
    }
    if (document.activeElement !== this.faceSelect && this.faceSelect.value !== String(extrusion.faceIndex)) {
      this.faceSelect.value = String(extrusion.faceIndex);
    }
    this.faceSelect.disabled = extrusion.dragging;
    this.faceSelect.title = extrusion.dragging ? 'Release to switch faces' : 'Which face to push or pull';
    this.faceNote.classList.toggle('hidden', !extrusion.dragging);

    if (!this.dirty(this.pullInput)) this.fill(this.pullInput, trimNumber(extrusion.pull));
    this.opDepth.textContent = formatMm(extrusion.depth);
    this.opBase.textContent = `${formatMm(extrusion.baseWidth)} × ${formatMm(extrusion.baseHeight)}`;

    const canApply = extrusion.previewValid;
    this.applyButton.disabled = !canApply;
    this.applyButton.title = canApply
      ? 'Commit the extrusion (Enter)'
      : Math.abs(extrusion.depth) < 1e-6
        ? 'Set a non-zero depth.'
        : 'The preview is degenerate — pull the face back out.';
  }

  private fill(input: HTMLInputElement, value: string): void {
    if (input.value !== value) input.value = value;
  }
}
