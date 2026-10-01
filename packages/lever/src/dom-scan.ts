/**
 * Phase 9 - Lever application form DOM scanning.
 *
 * The exported function is executed INSIDE the page through the public
 * `JaaPage.evaluate` API, so it must be fully self-contained (no
 * module-scope references - everything is inlined). It only reads the DOM
 * and returns plain serializable data. It never fills values, never
 * uploads files and never submits anything.
 *
 * The scan is modeled on Lever's actual application markup:
 *   form#application-form
 *     div.section.page-centered.application-form > h4 (section heading)
 *       ul > li.application-question(.custom-question)
 *         div.application-label(.full-width.{text|textarea|dropdown|
 *                                multiple-choice|multiple-select})
 *           div.text  -> question text (+ span.required "✱")
 *         div.application-field(.required-field)
 *           input/textarea/div.application-dropdown>select
 *           or ul[data-qa="multiple-choice"|"checkboxes"] of
 *             label > input + span.application-answer-alternative
 *
 * Labels, required flags and options are resolved from semantic
 * attributes and accessible relationships first - never from long
 * positional selectors.
 */

export interface LeverRawOption {
  value: string;
  label: string;
}

export type LeverRawFieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio-group'
  | 'checkbox-group'
  | 'checkbox'
  | 'file';

/** One discovered field/group - plain data, produced inside the page. */
export interface LeverRawField {
  /** Stable dedupe key (name or id). */
  key: string;
  kind: LeverRawFieldKind;
  label: string;
  required: boolean;
  options: LeverRawOption[] | null;
  section: string | null;
  cssSelector: string;
  attributes: Record<string, string>;
}

export interface LeverRawScan {
  formSelector: string | null;
  formFound: boolean;
  /** Structural markers proving the page really is a Lever page. */
  markers: string[];
  /** Markers of OTHER ATS platforms (a Lever page must not show them). */
  foreignMarkers: string[];
  /** CAPTCHA provider present on the form, if any (never solved by us). */
  captcha: string | null;
  fields: LeverRawField[];
}

/**
 * Scan the current document for a Lever application form and its fields.
 * Self-contained by design (executed inside the page).
 */
export function scanLeverPage(): LeverRawScan {
  const markers: string[] = [];
  const foreignMarkers: string[] = [];

  if (document.querySelector('li.application-question, div.application-question')) {
    markers.push('application-question');
  }
  if (document.querySelector('div.application-label')) markers.push('application-label');
  if (document.querySelector('span.application-answer-alternative')) markers.push('answer-alternative');
  if (document.querySelector('div.application-form')) markers.push('application-form-section');
  if (document.querySelector('div.application-dropdown')) markers.push('application-dropdown');
  if (document.querySelector('div.application-additional')) markers.push('application-additional');
  if (document.querySelector('[data-qa="additional-cards"]')) markers.push('additional-cards');
  if (document.querySelector('input[data-qa="email-input"], input[data-qa="name-input"]')) {
    markers.push('lever-data-qa');
  }
  if (document.querySelector('input[name^="cards["]')) markers.push('cards-fields');

  // Other ATS platforms use overlapping generic ids; their structural
  // class names are distinctive and disqualify this page.
  if (document.querySelector('form.application--form, div.application--questions')) {
    foreignMarkers.push('greenhouse-application-layout');
  }
  if (document.querySelector('div.application--submit, input.select__input')) {
    foreignMarkers.push('greenhouse-react-shell');
  }
  if (document.querySelector('#react-portal-mount-point, div.file-upload[aria-labelledby^="upload-label-"]')) {
    foreignMarkers.push('greenhouse-portal');
  }

  let captcha: string | null = null;
  if (document.querySelector('.h-captcha, #h-captcha, [name="h-captcha-response"]')) captcha = 'h-captcha';
  else if (document.querySelector('.g-recaptcha, [name="g-recaptcha-response"], iframe[src*="recaptcha"]')) {
    captcha = 'g-recaptcha';
  } else if (document.querySelector('.cf-turnstile, [name="cf-turnstile-response"]')) captcha = 'turnstile';

  // ---- form discovery: stable Lever identifiers first ------------------
  const formSelectors = [
    'form#application-form',
    'form.application-form',
    'form[action*="lever"]',
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

  const scan: LeverRawScan = {
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
    // Required markers are appended to label text (e.g. "Full name✱").
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
    // Never a bare `li`: Lever wraps each radio/checkbox OPTION in its own
    // li - the question container is li.application-question.
    return el.closest(
      'fieldset, .application-question, li.application-question, .field-wrapper, .application-field, [role="group"], [role="radiogroup"]'
    );
  }

  function groupLabelOf(el: Element): string {
    // The question label lives in div.application-label next to the field.
    const container = el.closest('.application-question, li.application-question, fieldset');
    if (!container) return '';
    const labelledBy = textOfIds(container.getAttribute('aria-labelledby'));
    if (labelledBy) return labelledBy;
    const legend = container.querySelector(':scope > legend, legend');
    if (legend) return textOf(legend);
    const explicit = container.querySelector('div.application-label, .application-label');
    if (explicit) return textOf(explicit);
    const labels = container.querySelectorAll('label');
    for (const l of Array.from(labels)) {
      if (!l.hasAttribute('for')) return textOf(l);
    }
    return '';
  }

  function resolveLabel(el: Element): string {
    // Lever labels wrap the control: label > div.application-label + field.
    // The application-label element is the precise label source.
    const container = el.closest('.application-question, li.application-question, fieldset');
    if (container) {
      const applicationLabel = container.querySelector('div.application-label, .application-label');
      if (applicationLabel) return textOf(applicationLabel);
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
    return (el.getAttribute('name') || id).replace(/\s+/g, ' ').trim();
  }

  function isRequired(el: Element, label: string): boolean {
    if (el.getAttribute('aria-required') === 'true') return true;
    if (el.hasAttribute('required') && el.getAttribute('aria-hidden') !== 'true') return true;
    if (/[*✱•·]\s*$/.test(label)) return true;
    const container = containerOf(el);
    if (container) {
      if (container.getAttribute('aria-required') === 'true') return true;
      // Lever marks required question containers with .required-field and
      // required labels with span.required.
      if (container.classList.contains('required-field')) return true;
      if (container.querySelector('span.required, .required-field')) return true;
    }
    return false;
  }

  function sectionOf(el: Element): string | null {
    // Lever sections are divs headed by an h4 ("Submit your application",
    // "Links", "Work Authorization", ...).
    const headings = form!.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let heading = '';
    for (const h of Array.from(headings)) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        heading = textOf(h);
      }
    }
    return heading ? cleanLabel(heading) : null;
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

  function groupCssSelector(name: string, el: Element): string {
    if (name) return '[name="' + name.replace(/"/g, '\\"') + '"]';
    return cssSelectorFor(el);
  }

  function attributesOf(el: Element, kind: LeverRawFieldKind): Record<string, string> {
    const attrs: Record<string, string> = {};
    const id = el.getAttribute('id') || '';
    const name = el.getAttribute('name') || '';
    if (id) attrs.id = id;
    if (name) attrs.name = name;
    attrs.tag = el.tagName.toLowerCase();
    if (kind !== 'select') {
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

  function optionLabel(el: Element): string {
    // Lever options: label > input + span.application-answer-alternative.
    const wrapping = el.closest('label');
    if (wrapping) return textOf(wrapping);
    const direct = labelForId(el.getAttribute('id') || '');
    if (direct) return direct;
    return (el as HTMLInputElement).value || '';
  }

  function optionsOfSelect(el: Element): LeverRawOption[] {
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
      // A group's label is the shared question label, not the first
      // option's own label. A lone checkbox keeps its own label.
      const kind: LeverRawFieldKind =
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

    let kind: LeverRawFieldKind = 'text';
    if (tag === 'textarea') kind = 'textarea';
    else if (tag === 'select') kind = 'select';
    else if (inputType === 'file') kind = 'file';

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
