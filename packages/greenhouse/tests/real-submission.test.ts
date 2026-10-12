import { describe, it, expect } from 'vitest';

import {
  buildFillGreenhouseFormScript,
  buildSelectOpenDropdownOptionScript,
  buildSubmitGreenhouseFormScript,
  buildReadGreenhouseConfirmationScript,
  describeGreenhouseRefusal,
  fillGreenhouseComboboxFields,
  interpretGreenhouseConfirmation,
  resolveApprovedComboboxChoice,
  type GreenhouseConfirmationReading,
  type GreenhouseFieldFillInput,
  type GreenhouseLiveOption,
} from '../src/real-submission';

/**
 * Phase 15B - real Greenhouse confirmation logic and in-page script
 * builders. The verdict table is safety-critical and fail-safe:
 *
 *  - CONFIRMED only from real provider evidence (explicit
 *    application-received confirmation, form gone, no visible refusal);
 *  - REJECTED only when the form actively refuses (visible errors) -
 *    never a guess;
 *  - everything else UNKNOWN, which is never retried blindly.
 */

function reading(overrides: Partial<GreenhouseConfirmationReading> = {}): GreenhouseConfirmationReading {
  return {
    url: 'https://job-boards.greenhouse.io/acme/jobs/1',
    formPresent: false,
    successMarker: null,
    errorMarkers: [],
    reference: null,
    ...overrides,
  };
}

describe('interpretGreenhouseConfirmation', () => {
  it('never guesses when there is no reading at all', () => {
    expect(interpretGreenhouseConfirmation(null)).toBe('UNKNOWN');
  });

  it('CONFIRMS only from an explicit application-received confirmation with the form gone', () => {
    expect(
      interpretGreenhouseConfirmation(
        reading({ successMarker: 'Thank you for applying', formPresent: false })
      )
    ).toBe('CONFIRMED');
  });

  it('never treats helper text on a still-open form as confirmation', () => {
    // e.g. "Once your application has been received, ..." next to the form:
    // the marker regex matches, but the form is still there, so this must
    // NOT be reported as submitted.
    expect(
      interpretGreenhouseConfirmation(
        reading({
          successMarker: 'your application has been received',
          formPresent: true,
        })
      )
    ).toBe('UNKNOWN');
  });

  it('never confirms while a visible refusal is present', () => {
    expect(
      interpretGreenhouseConfirmation(
        reading({
          successMarker: 'Thank you for applying',
          formPresent: true,
          errorMarkers: ['field-error'],
        })
      )
    ).not.toBe('CONFIRMED');
  });

  it('REJECTS only when the form actively refuses the submission', () => {
    expect(
      interpretGreenhouseConfirmation(
        reading({ formPresent: true, errorMarkers: ['required-error'] })
      )
    ).toBe('REJECTED');
    expect(
      interpretGreenhouseConfirmation(reading({ formPresent: true, errorMarkers: ['field-error'] }))
    ).toBe('REJECTED');
  });

  it('never claims "not submitted" for a form without visible errors (submit may be in flight)', () => {
    // The dangerous false negative: if the submission actually landed and we
    // report REJECTED, a human may apply again on top of it. So this state
    // is UNKNOWN, and UNKNOWN is never retried blindly.
    expect(interpretGreenhouseConfirmation(reading({ formPresent: true }))).toBe('UNKNOWN');
  });

  it('reports UNKNOWN when the page navigated away without any recognized confirmation', () => {
    expect(interpretGreenhouseConfirmation(reading({ formPresent: false }))).toBe('UNKNOWN');
  });

  it('reports UNKNOWN for error markers without the application form', () => {
    expect(
      interpretGreenhouseConfirmation(reading({ formPresent: false, errorMarkers: ['field-error'] }))
    ).toBe('UNKNOWN');
  });
});

describe('buildFillGreenhouseFormScript', () => {
  const fills: GreenhouseFieldFillInput[] = [
    { cssSelector: '#first_name', fieldType: 'TEXT', value: 'Test' },
    { cssSelector: '#email', fieldType: 'EMAIL', value: 'test-candidate@example.com' },
    { cssSelector: '#resume', fieldType: 'FILE', value: '/tmp/resume.pdf' },
    {
      cssSelector: 'input[name="auth"]',
      fieldType: 'RADIO',
      value: 'Yes',
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
    },
  ];

  it('embeds the fills as JSON so it is self-contained for JaaPage.evaluate', () => {
    const script = buildFillGreenhouseFormScript(fills);
    // JaaPage.evaluate passes no arguments; the data must be inlined.
    expect(script).toContain(JSON.stringify(fills));
    expect(script.trim().startsWith('(async function')).toBe(true);
  });

  it('never fills FILE fields in-page (uploads go through setInputFiles only)', () => {
    expect(buildFillGreenhouseFormScript(fills)).toContain(`f.fieldType === 'FILE'`);
  });

  it('reports filled and missed fields without echoing values to the page result', () => {
    const script = buildFillGreenhouseFormScript(fills);
    expect(script).toContain('filled');
    expect(script).toContain('missed');
    // The returned object must contain selectors only - the value variable
    // is used for filling, never returned.
    expect(script).toContain('return { filled: filled, missed: missed }');
    expect(script).not.toContain('value: f.value');
  });

  /** Execute the self-contained script against a minimal DOM stub. */
  function runFillScript(
    inputFills: GreenhouseFieldFillInput[],
    nodesBySelector: Record<string, unknown[]>
  ): Promise<{ filled: string[]; missed: string[] }> {
    const script = buildFillGreenhouseFormScript(inputFills);
    const documentStub = {
      querySelectorAll: (selector: string) => nodesBySelector[selector] ?? [],
    };
    const run = new Function('document', `return ${script}`) as (
      doc: unknown
    ) => Promise<{ filled: string[]; missed: string[] }>;
    return run(documentStub);
  }

  it('records a non-native SELECT (react-select combobox) as missed instead of crashing the fill run', async () => {
    // A combobox input has no .options property - the run must survive it.
    const comboboxNode = { value: '' };
    const result = await runFillScript(
      [
        { cssSelector: '#country', fieldType: 'SELECT', value: 'United States' },
        { cssSelector: '#first_name', fieldType: 'TEXT', value: 'Test' },
      ],
      { '#country': [comboboxNode] }
    );
    expect(result.missed).toContain('#country');
    expect(result.filled).not.toContain('#country');
  });

  it('fills a native SELECT by matching value or label', async () => {
    const events: string[] = [];
    const selectNode = {
      options: [
        { value: 'us', text: 'United States' },
        { value: 'de', text: 'Germany' },
      ],
      value: '',
      dispatchEvent: (e: { type: string }) => events.push(e.type),
    };
    const result = await runFillScript(
      [{ cssSelector: '#country', fieldType: 'SELECT', value: 'Germany' }],
      { '#country': [selectNode] }
    );
    expect(result.filled).toContain('#country');
    expect(selectNode.value).toBe('de');
    expect(events).toEqual(['input', 'change']);
  });
});

describe('buildSubmitGreenhouseFormScript', () => {
  it('clicks the form submit control and falls back to requestSubmit', () => {
    const script = buildSubmitGreenhouseFormScript('#application_form');
    expect(script).toContain('btn.click()');
    expect(script).toContain('requestSubmit');
    expect(script).toContain("method: 'none'");
  });

  it('is self-contained for JaaPage.evaluate', () => {
    expect(buildSubmitGreenhouseFormScript(null).trim().startsWith('(function')).toBe(true);
  });
});

describe('buildReadGreenhouseConfirmationScript', () => {
  it('returns structured confirmation evidence only - never raw page text', () => {
    const script = buildReadGreenhouseConfirmationScript();
    for (const key of ['url', 'formPresent', 'successMarker', 'errorMarkers', 'reference']) {
      expect(script).toContain(key);
    }
    // bodyText/body content is used for marker detection only and is never
    // part of the returned object.
    expect(script).not.toContain('bodyText');
    expect(script).not.toContain('body: body');
    expect(script).not.toContain('lower: lower');
  });

  it('is self-contained and read-only for JaaPage.evaluate', () => {
    const script = buildReadGreenhouseConfirmationScript();
    expect(script.trim().startsWith('(function')).toBe(true);
    // Read-only: no submission, no value setting, no clicking.
    expect(script).not.toContain('.submit()');
    expect(script).not.toContain('.click()');
    expect(script).not.toContain('dispatchEvent');
  });
});

// ---------------------------------------------------------------------------
// Phase 15B.1 - React Select grounding (selection only from approved answers)
// ---------------------------------------------------------------------------

describe('resolveApprovedComboboxChoice', () => {
  const live: GreenhouseLiveOption[] = [
    { value: 'United States', label: 'United States' },
    { value: 'Canada', label: 'Canada' },
    { value: 'United Kingdom', label: 'United Kingdom' },
  ];

  it('selects the single live option grounded in the approved answer', () => {
    expect(resolveApprovedComboboxChoice('Canada', null, live)).toEqual({
      value: 'Canada',
      label: 'Canada',
    });
  });

  it('grounds through the approved answer option entry (value -> label)', () => {
    const approvedOptions = [
      { value: 'CA', label: 'Canada' },
      { value: 'US', label: 'United States' },
    ];
    // The approved answer is stored as the option VALUE; the matching live
    // option is still the same approved choice (its label).
    expect(resolveApprovedComboboxChoice('CA', approvedOptions, live)).toEqual({
      value: 'Canada',
      label: 'Canada',
    });
  });

  it('is case- and whitespace-insensitive but never a partial match', () => {
    expect(resolveApprovedComboboxChoice('  canada ', null, live)).toEqual({
      value: 'Canada',
      label: 'Canada',
    });
    // "United" matches no live option exactly - never guessed.
    expect(resolveApprovedComboboxChoice('United', null, live)).toBeNull();
  });

  it('never falls back to a default or first option without a matching approved answer', () => {
    expect(resolveApprovedComboboxChoice('Germany', null, live)).toBeNull();
    expect(resolveApprovedComboboxChoice('', null, live)).toBeNull();
    expect(resolveApprovedComboboxChoice('   ', null, live)).toBeNull();
  });

  it('records a miss instead of guessing when the match is ambiguous', () => {
    const ambiguous: GreenhouseLiveOption[] = [
      { value: 'Yes', label: 'Yes' },
      { value: 'yes', label: 'Yes (2024)' },
    ];
    expect(resolveApprovedComboboxChoice('Yes', null, ambiguous)).toBeNull();
  });
});

describe('buildSelectOpenDropdownOptionScript', () => {
  /** Execute the self-contained script against an open-menu DOM stub. */
  function runSelectScript(
    label: string,
    optionTexts: string[]
  ): { clicked: string | null; selected: boolean } {
    let clicked: string | null = null;
    const documentStub = {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('[role="option"]');
        return optionTexts.map((text) => ({
          textContent: text,
          click: () => {
            clicked = text;
          },
        }));
      },
    };
    const run = new Function('document', `return ${buildSelectOpenDropdownOptionScript(label)}`) as (
      doc: unknown
    ) => boolean;
    const selected = run(documentStub);
    return { clicked, selected };
  }

  it('clicks exactly the grounded option and reports it', () => {
    const result = runSelectScript('Canada', ['United States', 'Canada', 'United Kingdom']);
    expect(result.selected).toBe(true);
    expect(result.clicked).toBe('Canada');
  });

  it('never clicks a default or partial match', () => {
    const result = runSelectScript('Germany', ['United States', 'Canada', 'United Kingdom']);
    expect(result.selected).toBe(false);
    expect(result.clicked).toBeNull();
  });
});

describe('fillGreenhouseComboboxFields (browser-abstraction orchestration)', () => {
  /** Minimal target stub: a fake dropdown with the given live options. */
  function stubTarget(liveOptions: GreenhouseLiveOption[]) {
    const actions: string[] = [];
    return {
      actions,
      evaluate<T>(pageFunction: string | ((arg?: unknown) => T)): Promise<T> {
        if (typeof pageFunction === 'function') {
          // readOpenDropdownOptions / closeOpenDropdown are passed as
          // functions; return the live options for the reader.
          const name = pageFunction.name;
          if (name === 'readOpenDropdownOptions') {
            return Promise.resolve(liveOptions as unknown as T);
          }
          actions.push('close');
          return Promise.resolve(true as unknown as T);
        }
        // The option-selection script: emulate the in-page click result.
        const match = /\)\((.*)\)\s*$/.exec(pageFunction);
        const label = match ? (JSON.parse(match[1]) as string) : '';
        const hit = liveOptions.find((o) => o.label === label);
        actions.push(hit ? `select:${label}` : `select-miss:${label}`);
        return Promise.resolve(Boolean(hit) as unknown as T);
      },
      click(selector: string): Promise<void> {
        actions.push(`click:${selector}`);
        return Promise.resolve();
      },
      waitForSelector(selector: string): Promise<void> {
        actions.push(`wait:${selector}`);
        return Promise.resolve();
      },
    };
  }

  it('selects only grounded options and records everything else as missed', async () => {
    const target = stubTarget([
      { value: 'Canada', label: 'Canada' },
      { value: 'Remote', label: 'Remote' },
    ]);
    const result = await fillGreenhouseComboboxFields(target, [
      { cssSelector: '#country', fieldType: 'SELECT', value: 'Canada' },
      { cssSelector: '#location', fieldType: 'SELECT', value: 'Germany' },
    ]);
    expect(result.filled).toEqual(['#country']);
    expect(result.missed).toEqual(['#location']);
    // The unmatched field's dropdown was closed without selecting anything:
    // no option-click was ever issued for it.
    expect(target.actions).toContain('close');
    expect(target.actions).not.toContain('select:Germany');
  });

  it('records a miss when a fill has no selector and never touches the page', async () => {
    const target = stubTarget([{ value: 'Canada', label: 'Canada' }]);
    const result = await fillGreenhouseComboboxFields(target, [
      { cssSelector: null, fieldType: 'SELECT', value: 'Canada' },
    ]);
    expect(result.filled).toEqual([]);
    expect(result.missed).toEqual(['(unlocatable dropdown field)']);
    expect(target.actions).toEqual([]);
  });
});

describe('describeGreenhouseRefusal (PII-free diagnostics)', () => {
  it('names the required questions that blocked progress - labels and types only', () => {
    const lines = describeGreenhouseRefusal(
      [
        { label: 'Email', type: 'EMAIL', required: true, filled: false },
        { label: 'Country', type: 'SELECT', required: true, filled: false },
        { label: 'Tell us about yourself', type: 'TEXTAREA', required: false, filled: false },
        { label: 'First Name', type: 'TEXT', required: true, filled: true },
      ],
      null
    );
    const joined = lines.join('\n');
    expect(joined).toContain('"Email" (EMAIL)');
    expect(joined).toContain('"Country" (SELECT)');
    // Optional and already-filled questions are not blockers.
    expect(joined).not.toContain('Tell us about yourself');
    expect(joined).not.toContain('First Name');
  });

  it('reports the challenge that blocked progress and never solves it', () => {
    const lines = describeGreenhouseRefusal([], {
      kind: 'CAPTCHA',
      detail: 'g-recaptcha',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('CAPTCHA');
    expect(joined).toContain('g-recaptcha');
    expect(joined).toContain('never solved or bypassed');
  });

  it('never carries candidate answers (values are not even accepted)', () => {
    // The field state type has no value slot: diagnostics structurally
    // cannot echo answers. This guard keeps it that way.
    const lines = describeGreenhouseRefusal(
      [{ label: 'Email', type: 'EMAIL', required: true, filled: false }],
      null
    );
    expect(JSON.stringify(lines)).not.toMatch(/@|answer|value/i);
  });
});
