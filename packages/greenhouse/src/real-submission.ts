/**
 * Phase 15B - controlled REAL Greenhouse form fill + submit + confirmation.
 *
 * This module holds the in-page scripts (executed through the public
 * `JaaPage.evaluate` API, which passes no arguments) and the pure
 * confirmation interpretation used ONLY by the real Greenhouse submission
 * path. The mock (Phase 15A) envelope path is untouched.
 *
 * Security invariants preserved here:
 *  - never solves or bypasses a CAPTCHA / MFA / security / bot challenge
 *    (the adapter re-scans for challenges after filling and before submit,
 *    and stops immediately if one appeared);
 *  - the fill values are used only to populate the live form - they are
 *    never logged, never placed in events, and never sent anywhere except
 *    the Greenhouse form itself;
 *  - a submission is only "confirmed" from real provider evidence (a
 *    provider confirmation id, or a confirmed success page). Nothing is
 *    faked; an ambiguous outcome is reported as UNKNOWN and never retried.
 */

import { readOpenDropdownOptions, closeOpenDropdown } from './dom-scan';

/** One prepared field value to fill into the live form. */
export interface GreenhouseFieldFillInput {
  cssSelector: string | null;
  /** ATS field type (TEXT, EMAIL, SELECT, RADIO, CHECKBOX, FILE, ...). */
  fieldType: string;
  value: string;
  options?: { value: string; label: string }[] | null;
}

/** Which fields were filled vs missed by the in-page fill pass. */
export interface GreenhouseFillResult {
  filled: string[];
  missed: string[];
}

/**
 * Build a self-contained in-page script that fills the given fields and
 * returns which were filled. `JaaPage.evaluate` passes no arguments, so the
 * fill data is embedded as JSON. Field values are set with the native value
 * setter and dispatched `input`/`change` events so React/controlled inputs
 * (Greenhouse job-boards layout) pick them up. FILE fields are skipped here
 * (uploads go through `JaaPage.setInputFiles`).
 */
export function buildFillGreenhouseFormScript(fills: GreenhouseFieldFillInput[]): string {
  return `(async function (fills) {
  function setNativeValue(el, value) {
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function labelOf(el) {
    var id = el.getAttribute('id') || '';
    if (id) {
      var l = document.querySelector('label[for="' + id.replace(/"/g, '\\\\"') + '"]');
      if (l) return (l.textContent || '').trim();
    }
    var wrap = el.closest('label');
    return wrap ? (wrap.textContent || '').trim() : '';
  }
  var filled = [];
  var missed = [];
  for (var i = 0; i < fills.length; i++) {
    var f = fills[i];
    if (!f || !f.cssSelector || f.fieldType === 'FILE') continue;
    var nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll(f.cssSelector)); } catch (e) { nodes = []; }
    if (nodes.length === 0) { missed.push(f.cssSelector); continue; }
    var type = (f.fieldType || '').toUpperCase();
    if (type === 'RADIO' || type === 'CHECKBOX') {
      var target = String(f.value == null ? '' : f.value).trim().toLowerCase();
      var matched = false;
      for (var n = 0; n < nodes.length; n++) {
        var opt = nodes[n];
        var val = String(opt.value || '').trim().toLowerCase();
        var lab = labelOf(opt).toLowerCase();
        if (val === target || lab === target) {
          opt.checked = true;
          opt.dispatchEvent(new Event('input', { bubbles: true }));
          opt.dispatchEvent(new Event('change', { bubbles: true }));
          matched = true;
        }
      }
      if (matched) filled.push(f.cssSelector); else missed.push(f.cssSelector);
      continue;
    }
    if (type === 'SELECT') {
      var sel = nodes[0];
      var want = String(f.value == null ? '' : f.value).trim();
      var wantLower = want.toLowerCase();
      var chosen = null;
      // Only native <select> elements expose options. A combobox input
      // (react-select) has none and cannot be populated by this value pass;
      // it is reported as missed instead of failing the whole fill run.
      if (!sel || !sel.options) { missed.push(f.cssSelector); continue; }
      for (var o = 0; o < sel.options.length; o++) {
        var option = sel.options[o];
        if (String(option.value).trim() === want || (option.text || '').trim().toLowerCase() === wantLower) {
          chosen = option;
          break;
        }
      }
      if (chosen) {
        sel.value = chosen.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        filled.push(f.cssSelector);
      } else {
        missed.push(f.cssSelector);
      }
      continue;
    }
    // Default: single-line / multi-line text-like inputs.
    setNativeValue(nodes[0], String(f.value == null ? '' : f.value));
    filled.push(f.cssSelector);
  }
  return { filled: filled, missed: missed };
})(${JSON.stringify(fills)})`;
}

// ---------------------------------------------------------------------------
// React Select (combobox) handling - grounded selection only (Phase 15B.1)
// ---------------------------------------------------------------------------

/** A live dropdown option read from an open combobox menu. */
export interface GreenhouseLiveOption {
  value: string;
  label: string;
}

/** Whitespace-collapsed, case-insensitive comparison key. */
function optionKey(text: string): string {
  return String(text ?? '')
    .split(' ')
    .filter((part) => part.length > 0)
    .join(' ')
    .toLowerCase();
}

/**
 * Resolve the single live combobox option that is GROUNDED in the approved
 * answer - never a guess:
 *
 *  - the approved answer (`approvedValue`) must be non-empty;
 *  - a live option matches only when its value or label equals the approved
 *    answer (or the label/value of the approved answer's own option entry);
 *  - exactly ONE distinct live option must match. Zero matches (no safe
 *    match) and ambiguous matches both resolve to null - the caller then
 *    records the field as missed instead of selecting anything.
 *
 * Pure function: no DOM, no network. Defaults/first options are NEVER
 * selected implicitly.
 */
export function resolveApprovedComboboxChoice(
  approvedValue: string,
  approvedOptions: { value: string; label: string }[] | null | undefined,
  liveOptions: GreenhouseLiveOption[]
): GreenhouseLiveOption | null {
  const target = optionKey(approvedValue);
  if (!target) return null;

  const approvedKeys = new Set<string>([target]);
  for (const opt of approvedOptions ?? []) {
    if (optionKey(opt.value) === target || optionKey(opt.label) === target) {
      approvedKeys.add(optionKey(opt.value));
      approvedKeys.add(optionKey(opt.label));
    }
  }

  const matches: GreenhouseLiveOption[] = [];
  const seen = new Set<string>();
  for (const live of liveOptions ?? []) {
    const liveValue = optionKey(live.value);
    const liveLabel = optionKey(live.label);
    if (approvedKeys.has(liveValue) || approvedKeys.has(liveLabel)) {
      const dedupeKey = `${liveValue}|${liveLabel}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        matches.push(live);
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Build a self-contained in-page script that clicks the OPEN dropdown
 * option whose visible label equals the given (already approved and
 * grounded) label. It never synthesizes a value, never picks a default, and
 * reports whether the option was found and clicked.
 */
export function buildSelectOpenDropdownOptionScript(label: string): string {
  return `(function (label) {
  var want = String(label || '').split(' ').filter(function (p) { return p.length > 0; }).join(' ').toLowerCase();
  var nodes = document.querySelectorAll('[role="option"]');
  for (var i = 0; i < nodes.length; i++) {
    var text = (nodes[i].textContent || '').split(' ').filter(function (p) { return p.length > 0; }).join(' ').toLowerCase();
    if (text === want) { nodes[i].click(); return true; }
  }
  return false;
})(${JSON.stringify(label)})`;
}

/**
 * The minimal DOM interaction surface fill operations need. Both the main
 * document (JaaPage) and an SSRF-approved embed frame (JaaFrame) satisfy it
 * structurally - this package never imports Playwright or @jaa/browser.
 */
export interface GreenhouseInteractionTarget {
  evaluate<T>(pageFunction: string | ((arg?: unknown) => T)): Promise<T>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
}

/**
 * Fill React Select (combobox) fields through the existing browser
 * abstraction (the same click / waitForSelector / evaluate surface the
 * adapter already uses): open the menu, read the LIVE options, and select
 * only an option grounded in the approved answer - the prepared value, or
 * that value's own approved option label/value pair. When no SINGLE live
 * option matches (absent or ambiguous), the field is left unfilled and
 * recorded as missed: a default or first option is NEVER selected
 * implicitly, and values are never logged.
 */
export async function fillGreenhouseComboboxFields(
  target: GreenhouseInteractionTarget,
  fills: GreenhouseFieldFillInput[]
): Promise<GreenhouseFillResult> {
  const filled: string[] = [];
  const missed: string[] = [];
  for (const fill of fills) {
    const selector = fill.cssSelector;
    if (!selector) {
      missed.push('(unlocatable dropdown field)');
      continue;
    }
    try {
      await target.click(selector);
      await target.waitForSelector('[role="option"]', 1500).catch(() => undefined);
      const live = await target.evaluate(readOpenDropdownOptions);
      const choice = resolveApprovedComboboxChoice(fill.value, fill.options ?? null, live);
      if (!choice) {
        // No safe match: close the menu untouched and record a miss.
        await target.evaluate(closeOpenDropdown).catch(() => undefined);
        missed.push(selector);
        continue;
      }
      const clicked = await target.evaluate(buildSelectOpenDropdownOptionScript(choice.label));
      if (clicked) {
        filled.push(selector);
      } else {
        await target.evaluate(closeOpenDropdown).catch(() => undefined);
        missed.push(selector);
      }
    } catch {
      missed.push(selector);
      await target.evaluate(closeOpenDropdown).catch(() => undefined);
    }
  }
  return { filled, missed };
}

/**
 * PII-free refusal diagnostics: which required questions stayed unfilled
 * and which challenge blocked progress. Field labels and types only -
 * never candidate answers, never values, never cookies or credentials.
 */
export interface GreenhouseRefusalFieldState {
  label: string;
  type: string;
  required: boolean;
  filled: boolean;
}

export function describeGreenhouseRefusal(
  fields: GreenhouseRefusalFieldState[],
  challenge: { kind: string; detail: string } | null
): string[] {
  const lines: string[] = [];
  const unfilledRequired = fields.filter((f) => f.required && !f.filled);
  if (unfilledRequired.length > 0) {
    lines.push(
      `Required question(s) left unfilled: ${unfilledRequired
        .map((f) => `"${f.label}" (${f.type})`)
        .join('; ')}`
    );
  } else {
    lines.push('All required questions were filled; the refusal is not explained by missing answers');
  }
  if (challenge) {
    lines.push(
      `Progress is blocked by a ${challenge.kind} challenge (${challenge.detail}); it is never solved or bypassed`
    );
  }
  return lines;
}

/** Result of clicking the form's submit control. */
export interface GreenhouseSubmitClickResult {
  clicked: boolean;
  method: 'button' | 'requestSubmit' | 'none';
}

/**
 * Build a self-contained in-page script that triggers the form submission by
 * clicking its submit control (most realistic - runs the form's own handlers
 * and validation), falling back to `requestSubmit()`. It never bypasses
 * validation and never fabricates a submission.
 */
export function buildSubmitGreenhouseFormScript(formSelector: string | null): string {
  return `(function (formSelector) {
  var form = formSelector ? document.querySelector(formSelector) : document.querySelector('form');
  if (!form) return { clicked: false, method: 'none' };
  var btn = form.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
  if (btn) { btn.click(); return { clicked: true, method: 'button' }; }
  if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return { clicked: true, method: 'requestSubmit' }; }
  return { clicked: false, method: 'none' };
})(${JSON.stringify(formSelector)})`;
}

/** Raw confirmation reading taken from the page after a submit attempt. */
export interface GreenhouseConfirmationReading {
  url: string;
  /** A form with application fields is still present (submission did not land). */
  formPresent: boolean;
  /** A specific application-received / thank-you confirmation is present. */
  successMarker: string | null;
  /** Field-validation error markers are present (submission was refused). */
  errorMarkers: string[];
  /** Provider confirmation reference when the page exposes one. */
  reference: string | null;
}

/**
 * Build a self-contained in-page script that reads the current page for
 * submission confirmation evidence. Read-only: it never submits or changes
 * anything. `bodyText` is used only to detect markers and is never returned.
 */
export function buildReadGreenhouseConfirmationScript(): string {
  return `(function () {
  var body = (document.body && document.body.textContent) || '';
  var lower = body.toLowerCase();
  var success = null;
  var successPatterns = [
    /thank you for (your )?appl(y|ying|ication)/i,
    /your application has been (received|submitted)/i,
    /we (have )?received your application/i,
    /application (has been )?(received|submitted|complete)/i,
    /application received/i,
    /successfully submitted/i
  ];
  for (var s = 0; s < successPatterns.length; s++) {
    var m = body.match(successPatterns[s]);
    if (m) { success = m[0]; break; }
  }
  var errorMarkers = [];
  if (document.querySelector('.field-error, .error, [aria-invalid="true"], .application--errors, #error-box')) {
    errorMarkers.push('field-error');
  }
  if (/please (fix|correct|enter|select|provide)/i.test(body) || /is required/i.test(body)) {
    errorMarkers.push('required-error');
  }
  var formPresent = false;
  var forms = document.querySelectorAll('form');
  for (var i = 0; i < forms.length; i++) {
    if (forms[i].querySelector('input:not([type="hidden"]), select, textarea')) { formPresent = true; break; }
  }
  var reference = null;
  var refMatch = body.match(/(?:confirmation|application|reference)\\s*(?:number|no\\.?|#|:|id|code)\\s*([A-Za-z0-9-]{4,})/i);
  if (refMatch && refMatch[1] && /[0-9]/.test(refMatch[1])) reference = refMatch[1];
  if (!reference) {
    try {
      var u = new URL(window.location.href);
      reference = u.searchParams.get('application_id') || u.searchParams.get('confirmation') || null;
    } catch (e) { reference = null; }
  }
  return {
    url: window.location.href,
    formPresent: formPresent,
    successMarker: success,
    errorMarkers: errorMarkers,
    reference: reference
  };
})()`;
}

/** Final interpretation of a submission attempt's confirmation state. */
export type GreenhouseConfirmationVerdict = 'CONFIRMED' | 'REJECTED' | 'UNKNOWN';

/**
 * Interpret a confirmation reading. This is the real Greenhouse confirmation
 * logic - conservative and fail-safe. The two dangerous mistakes are
 * asymmetric: falsely claiming "submitted" hides a missed application, while
 * falsely claiming "not submitted" invites a manual re-apply on top of a
 * submission that DID land (a double application). So nothing is ever
 * resolved without proof:
 *
 *  - CONFIRMED : the page shows an explicit application-received
 *    confirmation, the application form is GONE (the page really is the
 *    success page - a form page containing helper text like "once your
 *    application has been received..." must never count), and no refusal is
 *    visible. This is real provider evidence (STEP 8: a confirmed success
 *    page), never a fabricated condition.
 *  - REJECTED  : the application form is still present and ACTIVELY refuses
 *    the input (visible validation / required-error markers). Definitive:
 *    the submission did not happen.
 *  - UNKNOWN   : anything else - including "the form is still present with
 *    no errors" (the submit may still be in flight) and "the page changed
 *    but no recognized confirmation is present". The outcome cannot be
 *    proven either way, so it is never reported as a definitive result and
 *    never retried blindly.
 */
export function interpretGreenhouseConfirmation(
  reading: GreenhouseConfirmationReading | null
): GreenhouseConfirmationVerdict {
  if (!reading) return 'UNKNOWN';
  const refused = reading.errorMarkers.length > 0;
  if (reading.successMarker && !reading.formPresent && !refused) return 'CONFIRMED';
  if (refused && reading.formPresent) return 'REJECTED';
  return 'UNKNOWN';
}
