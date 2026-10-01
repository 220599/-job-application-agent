/**
 * Phase 8 - Greenhouse application form DOM scanning.
 *
 * The exported functions in this file are executed INSIDE the page through
 * the public `JaaPage.evaluate` API, so each one must be fully
 * self-contained (no module-scope references - everything is inlined).
 * They only read the DOM and return plain serializable data. They never
 * fill values, never upload files and never submit anything.
 *
 * The scan understands both Greenhouse layouts the same field can appear
 * in: the current job-boards layout (job-boards.greenhouse.io, React-based
 * with aria-required and react-select comboboxes) and the classic boards
 * layout (boards.greenhouse.io, plain HTML inputs/selects with
 * `job_application[...]` names). Labels, required flags and options are
 * resolved from semantic attributes and accessible relationships first -
 * never from long positional selectors.
 */

export interface GreenhouseRawOption {
  value: string;
  label: string;
}

export type GreenhouseRawFieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'combobox'
  | 'radio-group'
  | 'checkbox-group'
  | 'checkbox'
  | 'file';

/** One discovered field/group - plain data, produced inside the page. */
export interface GreenhouseRawField {
  /** Stable dedupe key (name or id). */
  key: string;
  kind: GreenhouseRawFieldKind;
  label: string;
  required: boolean;
  options: GreenhouseRawOption[] | null;
  section: string | null;
  cssSelector: string;
  attributes: Record<string, string>;
}

export interface GreenhouseRawScan {
  formSelector: string | null;
  formFound: boolean;
  /** Structural markers proving the page really is a Greenhouse page. */
  markers: string[];
  /** Markers of OTHER ATS platforms (a Greenhouse page must not show them). */
  foreignMarkers: string[];
  /** CAPTCHA provider present on the form, if any (never solved by us). */
  captcha: string | null;
  fields: GreenhouseRawField[];
}

/**
 * Scan the current document for a Greenhouse application form and its
 * fields. Self-contained by design (executed inside the page).
 */
export function scanGreenhousePage(): GreenhouseRawScan {
  const markers: string[] = [];
  const foreignMarkers: string[] = [];

  if (document.querySelector('form.application--form')) markers.push('form.application--form');
  if (document.querySelector('div.application--questions')) markers.push('div.application--questions');
  if (document.querySelector('div.application--submit')) markers.push('div.application--submit');
  if (document.querySelector('#react-portal-mount-point')) markers.push('react-portal-mount-point');
  if (document.querySelector('input.select__input, div.select__container')) markers.push('react-select-shell');
  if (document.querySelector('div.file-upload[aria-labelledby^="upload-label-"]')) markers.push('file-upload-group');
  if (document.querySelector('input[name^="job_application["]')) markers.push('job_application-fields');
  if (document.querySelector('form#application_form')) markers.push('form#application_form');
  if (document.querySelector('a[href*="greenhouse.io"], a[href*="greenhouse.com"], [class*="greenhouse"]')) {
    markers.push('greenhouse-branding');
  }

  // Other ATS platforms use overlapping generic ids; their structural
  // class names are distinctive and disqualify this page.
  if (document.querySelector('li.application-question, div.application-question')) {
    foreignMarkers.push('lever-application-question');
  }
  if (document.querySelector('div.application-label, span.application-answer-alternative')) {
    foreignMarkers.push('lever-application-label');
  }

  let captcha: string | null = null;
  if (document.querySelector('.h-captcha, #h-captcha, [name="h-captcha-response"]')) captcha = 'h-captcha';
  else if (document.querySelector('.g-recaptcha, [name="g-recaptcha-response"], iframe[src*="recaptcha"]')) {
    captcha = 'g-recaptcha';
  } else if (document.querySelector('.cf-turnstile, [name="cf-turnstile-response"]')) captcha = 'turnstile';

  // ---- form discovery: stable Greenhouse identifiers first -------------
  const formSelectors = [
    'form#application-form',
    'form.application--form',
    'form#application_form',
    'form.application_form',
    'form[action*="greenhouse"]',
    'form',
  ];
  let form: HTMLFormElement | null = null;
  let formSelector: string | null = null;
  for (const sel of formSelectors) {
    const candidate = document.querySelector(sel);
    if (candidate) {
      form = candidate as HTMLFormElement;
      formSelector = sel;
      break;
    }
  }

  const scan: GreenhouseRawScan = {
    formSelector,
    formFound: form !== null,
    markers,
    foreignMarkers,
    captcha,
    fields: [],
  };
  if (!form) return scan;

  // ---- helpers (inlined - this function is serialized) -----------------

  function cleanLabel(text: string): string {
    let t = (text || '').replace(/\s+/g, ' ').trim();
    // Required markers are appended to label text in both layouts.
    while (t.length > 0 && /[*✱•·*]/.test(t.charAt(t.length - 1))) {
      t = t.slice(0, -1).trim();
    }
    return t;
  }

  /** Whitespace-collapsed raw text - keeps required markers (see isRequired). */
  function textOf(el: Element | null): string {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function labelForId(id: string): string {
    if (!id) return '';
    const labels = document.querySelectorAll('label[for]');
    for (const l of Array.from(labels)) {
      if (l.getAttribute('for') === id) return textOf(l);
    }
    return '';
  }

  function groupCssSelector(name: string, el: Element): string {
    if (name) return '[name="' + name.replace(/"/g, '\\"') + '"]';
    return cssSelectorFor(el);
  }

  function textOfIds(idsAttr: string | null): string {
    if (!idsAttr) return '';
    const parts: string[] = [];
    for (const id of idsAttr.split(/\s+/)) {
      const el = id ? document.getElementById(id) : null;
      const t = textOf(el);
      if (t) parts.push(t);
    }
    return parts.join(' ').trim();
  }

  function containerOf(el: Element): Element | null {
    // Never a bare `li`: providers wrap each radio/checkbox OPTION in its
    // own li - the question container is the classed/fieldset ancestor.
    return el.closest(
      'fieldset, .application-question, li.application-question, .field-wrapper, .application--questions, .eeoc__question__wrapper, .field, [role="group"], [role="radiogroup"], .application-label, .upload-label'
    );
  }

  function groupLabelOf(el: Element): string {
    const container = containerOf(el);
    if (!container) return '';
    const labelledBy = textOfIds(container.getAttribute('aria-labelledby'));
    if (labelledBy) return labelledBy;
    const legend = container.querySelector(':scope > legend, legend');
    if (legend) return textOf(legend);
    const explicit = container.querySelector('.application-label, .upload-label, .label');
    if (explicit) return textOf(explicit);
    const labels = container.querySelectorAll('label');
    for (const l of Array.from(labels)) {
      if (!l.hasAttribute('for')) return textOf(l);
    }
    return '';
  }

  function resolveLabel(el: Element): string {
    // File uploads label the whole upload group (e.g. "Resume/CV"), while a
    // label[for] on the input itself is often just a utility ("Attach").
    if ((el as HTMLInputElement).type === 'file') {
      const group = groupLabelOf(el);
      if (group) return group;
    }
    const id = el.getAttribute('id') || '';
    const direct = labelForId(id);
    if (direct) return direct;
    const viaLabelledBy = textOfIds(el.getAttribute('aria-labelledby'));
    if (viaLabelledBy) return viaLabelledBy;
    const aria = el.getAttribute('aria-label');
    if (aria) return (aria || '').replace(/\s+/g, ' ').trim();
    const wrapping = el.closest('label');
    if (wrapping) return textOf(wrapping);
    const group = groupLabelOf(el);
    if (group) return group;
    return (el.getAttribute('name') || id).replace(/\s+/g, ' ').trim();
  }

  function isRequired(el: Element, label: string): boolean {
    if (el.getAttribute('aria-required') === 'true') return true;
    if (el.hasAttribute('required') && el.getAttribute('aria-hidden') !== 'true') return true;
    if (/[*✱•·]\s*$/.test(label)) return true;
    const container = containerOf(el);
    if (container) {
      if (container.getAttribute('aria-required') === 'true') return true;
      if (container.querySelector('span.required, .required-field')) return true;
    }
    return false;
  }

  function sectionOf(el: Element): string | null {
    // 1. nearest preceding heading inside the form
    const headings = form!.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let heading = '';
    for (const h of Array.from(headings)) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        heading = textOf(h);
      }
    }
    if (heading) return heading;
    // 2. enclosing fieldset legend
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      const t = textOf(legend);
      if (t) return t;
    }
    return null;
  }

  function cssSelectorFor(el: Element): string {
    const id = el.getAttribute('id') || '';
    if (id) {
      return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) ? '#' + id : '[id="' + id + '"]';
    }
    const name = el.getAttribute('name') || '';
    if (name) return '[name="' + name.replace(/"/g, '\\"') + '"]';
    const qa = el.getAttribute('data-qa');
    if (qa) return '[data-qa="' + qa + '"]';
    return el.tagName.toLowerCase();
  }

  function attributesOf(el: Element, kind: GreenhouseRawFieldKind): Record<string, string> {
    const attrs: Record<string, string> = {};
    const id = el.getAttribute('id') || '';
    const name = el.getAttribute('name') || '';
    if (id) attrs.id = id;
    if (name) attrs.name = name;
    attrs.tag = el.tagName.toLowerCase();
    if (kind !== 'select' && kind !== 'combobox') {
      const type = (el as HTMLInputElement).type;
      if (type) attrs.inputType = type;
    }
    const autocomplete = el.getAttribute('autocomplete');
    if (autocomplete) attrs.autocomplete = autocomplete;
    const accept = el.getAttribute('accept');
    if (accept) attrs.accept = accept;
    const role = el.getAttribute('role');
    if (role) attrs.role = role;
    const qa = el.getAttribute('data-qa');
    if (qa) attrs['data-qa'] = qa;
    // Greenhouse custom question ids are stable external identifiers.
    const qMatch = /^question_(\d+)$/.exec(id);
    if (qMatch) attrs.questionId = qMatch[1];
    return attrs;
  }

  function isSkipped(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || '').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') {
        return true;
      }
    }
    return false;
  }

  function isCombobox(el: Element): boolean {
    return (
      el.getAttribute('role') === 'combobox' ||
      el.classList.contains('select__input') ||
      el.getAttribute('aria-haspopup') === 'listbox'
    );
  }

  function optionLabel(el: Element): string {
    const wrapping = el.closest('label');
    if (wrapping) return textOf(wrapping);
    const direct = labelForId(el.getAttribute('id') || '');
    if (direct) return direct;
    return (el as HTMLInputElement).value || '';
  }

  function optionsOfSelect(el: Element): GreenhouseRawOption[] {
    return Array.from(el.querySelectorAll('option')).map((o) => ({
      value: (o as HTMLOptionElement).value,
      label: cleanLabel((o as HTMLOptionElement).text || (o as HTMLOptionElement).value),
    }));
  }

  // ---- field collection ------------------------------------------------

  const elements = Array.from(form.querySelectorAll('input, select, textarea'));
  const seenGroups = new Set<string>();

  for (const el of elements) {
    if (isSkipped(el)) continue;
    const tag = el.tagName.toLowerCase();
    const inputType = ((el as HTMLInputElement).type || '').toLowerCase();
    const name = el.getAttribute('name') || '';
    const id = el.getAttribute('id') || '';

    if (tag === 'input' && (inputType === 'radio' || inputType === 'checkbox')) {
      const key = name || id;
      if (!key || seenGroups.has(key)) continue;
      seenGroups.add(key);
      const peers = elements.filter(
        (p) =>
          !isSkipped(p) &&
          p.tagName.toLowerCase() === 'input' &&
          ((p as HTMLInputElement).type || '').toLowerCase() === inputType &&
          (p.getAttribute('name') || '') === name &&
          name !== ''
      );
      const members = peers.length > 0 ? peers : [el];
      const options = members.map((m) => ({
        value: (m as HTMLInputElement).value,
        label: optionLabel(m),
      }));
      // A group's label is the shared question label (container), not the
      // first option's own label. A lone checkbox keeps its own label.
      const kind: GreenhouseRawFieldKind =
        inputType === 'radio' ? 'radio-group' : members.length > 1 ? 'checkbox-group' : 'checkbox';
      const label =
        kind === 'checkbox'
          ? resolveLabel(el) || groupLabelOf(el)
          : groupLabelOf(el) || resolveLabel(el);
      const required = members.some((m) => isRequired(m, label));
      scan.fields.push({
        key,
        kind,
        label: cleanLabel(label) || key,
        required,
        options: kind === 'checkbox' ? null : options,
        section: sectionOf(el),
        cssSelector: groupCssSelector(name, el),
        attributes: attributesOf(el, kind),
      });
      continue;
    }

    let kind: GreenhouseRawFieldKind = 'text';
    if (tag === 'textarea') kind = 'textarea';
    else if (tag === 'select') kind = 'select';
    else if (inputType === 'file') kind = 'file';
    else if (isCombobox(el)) kind = 'combobox';

    const label = resolveLabel(el);
    scan.fields.push({
      key: name || id || label,
      kind,
      label: cleanLabel(label) || name || id,
      required: isRequired(el, label),
      options: kind === 'select' ? optionsOfSelect(el) : null,
      section: sectionOf(el),
      cssSelector: cssSelectorFor(el),
      attributes: attributesOf(el, kind),
    });
  }

  return scan;
}

/**
 * Read the options of an OPEN dropdown menu (react-select renders them
 * into a portal as role="option" nodes). Self-contained.
 */
export function readOpenDropdownOptions(): GreenhouseRawOption[] {
  const out: GreenhouseRawOption[] = [];
  const nodes = document.querySelectorAll('[role="option"]');
  for (const n of Array.from(nodes)) {
    const label = (n.textContent || '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    out.push({ value: label, label });
  }
  return out;
}

/**
 * Close an open custom dropdown without selecting anything: dispatch an
 * Escape key event to the focused control (react-select closes on it) and
 * blur. Self-contained. Never submits.
 */
export function closeOpenDropdown(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active && typeof active.dispatchEvent === 'function') {
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    active.blur();
  }
  return true;
}
