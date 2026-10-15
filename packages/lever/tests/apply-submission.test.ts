/**
 * Phase 15C - prepared-answer -> documented-schema mapping tests.
 *
 * Proves the never-fabricate contract of the API path:
 *  - a label that matches exactly one documented field maps to THAT field;
 *  - choice answers are only ever sent as documented option values that the
 *    approved answer actually matches - never a guess, never a default;
 *  - custom question values are emitted in the DOCUMENTED field order;
 *  - required fields without a grounded answer are PII-free violations that
 *    BLOCK before any request is sent;
 *  - unmappable answers are warnings, never invented fields;
 *  - diagnostics never contain answer values.
 */

import { describe, it, expect } from 'vitest';

import type { AtsFieldFill } from '@jaa/ats';

import type { LeverApplyQuestions } from '../src/apply-api';
import { buildLeverApplyInput, withLeverResumeUri } from '../src/apply-submission';

const SENTINEL = 'Qwerty-Secret-Answer-42';

const QUESTIONS: LeverApplyQuestions = {
  postingId: '250d8f03-738a-4bba-a671-8a3d73477145',
  postingText: 'Test Engineer',
  personalInformation: [
    { name: 'fullName', text: 'Full name', type: 'text', required: true },
    { name: 'email', text: 'Email', type: 'text', required: true },
    { name: 'currentCompany', text: 'Current company', type: 'text', required: false },
    { name: 'resume', text: 'Resume', type: 'file-upload', required: false },
    { name: 'additionalInformation', text: 'Additional information', type: 'textarea', required: false },
  ],
  urls: [
    { name: 'LinkedIn', text: 'LinkedIn', type: 'text', required: false },
    { name: 'Github', text: 'Github', type: 'text', required: false },
  ],
  customQuestions: [
    {
      id: 'set-1',
      text: 'Screening',
      fields: [
        {
          id: 'f-auth',
          text: 'Are you authorized to work in the United States?',
          type: 'dropdown',
          required: true,
          options: [
            { text: 'Yes', optionId: 'Yes' },
            { text: 'No', optionId: 'No' },
          ],
        },
        {
          id: 'f-languages',
          text: 'Which languages or frameworks are you comfortable with?',
          type: 'multiple-select',
          required: false,
          options: [
            { text: 'JavaScript', optionId: 'JavaScript' },
            { text: 'Python', optionId: 'Python' },
            { text: 'Ruby', optionId: 'Ruby' },
          ],
        },
        {
          id: 'f-experience',
          text: 'What experience do you have?',
          type: 'textarea',
          required: false,
        },
      ],
    },
  ],
  eeoQuestions: {
    gender: {
      name: 'gender',
      text: 'Gender',
      type: 'dropdown',
      required: false,
      options: [
        { text: 'Female', optionId: 'Female' },
        { text: 'Male', optionId: 'Male' },
      ],
    },
  },
};

function fill(partial: Partial<AtsFieldFill> & { value: string }): AtsFieldFill {
  return {
    questionId: partial.questionId ?? `q-${Math.random().toString(36).slice(2)}`,
    fieldType: partial.fieldType ?? 'TEXT',
    locator: partial.locator ?? null,
    value: partial.value,
    required: partial.required ?? false,
    options: partial.options ?? null,
    label: partial.label ?? null,
    externalFieldId: partial.externalFieldId ?? null,
  };
}

describe('buildLeverApplyInput - grounded mapping only', () => {
  it('maps labeled answers onto the documented fields and preserves documented custom-field order', () => {
    const build = buildLeverApplyInput({
      questions: QUESTIONS,
      fills: [
        fill({ label: 'Full name', value: 'Test Candidate' }),
        fill({ label: 'Email', value: 'test-candidate@test.invalid' }),
        fill({ label: 'Current company', value: 'Brickly LLC' }),
        fill({ label: 'LinkedIn', value: 'https://linkedin.com/in/test-candidate' }),
        fill({
          label: 'Are you authorized to work in the United States?',
          value: 'Yes',
          fieldType: 'SELECT',
        }),
        fill({
          label: 'Which languages or frameworks are you comfortable with?',
          value: 'JavaScript, Ruby',
          fieldType: 'CHECKBOX',
        }),
        fill({ label: 'What experience do you have?', value: SENTINEL, fieldType: 'TEXTAREA' }),
      ],
      resumeFileName: 'approved-resume.pdf',
    });

    expect(build.violations).toEqual([]);
    expect(build.input.personalInformation).toEqual([
      { name: 'fullName', value: 'Test Candidate' },
      { name: 'email', value: 'test-candidate@test.invalid' },
      { name: 'currentCompany', value: 'Brickly LLC' },
    ]);

    // Documented custom field ORDER: auth, languages, experience - exactly
    // the schema order with a value slot for every documented field.
    expect(build.input.customQuestions).toEqual([
      {
        id: 'set-1',
        fields: [{ value: 'Yes' }, { value: ['JavaScript', 'Ruby'] }, { value: SENTINEL }],
      },
    ]);
    expect(build.input.urls).toEqual([
      { name: 'LinkedIn', value: 'https://linkedin.com/in/test-candidate' },
    ]);
  });

  it('never guesses a choice: an unmatched answer is a violation for required fields, a warning otherwise', () => {
    const build = buildLeverApplyInput({
      questions: QUESTIONS,
      fills: [
        fill({ label: 'Full name', value: 'Test Candidate' }),
        fill({ label: 'Email', value: 'test-candidate@test.invalid' }),
        fill({
          label: 'Are you authorized to work in the United States?',
          value: 'Absolutely, with relocation support',
          fieldType: 'SELECT',
        }),
        fill({
          label: 'Which languages or frameworks are you comfortable with?',
          value: 'COBOL',
          fieldType: 'CHECKBOX',
        }),
      ],
    });
    // Required dropdown with an unmatchable answer blocks the submission.
    expect(build.violations.some((v) => v.field.includes('authorized'))).toBe(true);
    // Optional multi-select with an unmatchable answer is warned, never sent.
    expect(build.warnings.some((w) => w.includes('languages'))).toBe(true);
    expect(JSON.stringify(build.input)).not.toContain('COBOL');
  });

  it('blocks (never fabricates) when a required documented question has no grounded answer', () => {
    const build = buildLeverApplyInput({
      questions: QUESTIONS,
      fills: [
        fill({ label: 'Full name', value: 'Test Candidate' }),
        // No email, no required custom answer: both are violations.
      ],
    });
    expect(build.violations.some((v) => v.field === 'email')).toBe(true);
    expect(build.violations.some((v) => v.field.includes('authorized'))).toBe(true);
  });

  it('composes the documented fullName from approved first+last name answers (composition, not fabrication)', () => {
    const build = buildLeverApplyInput({
      questions: QUESTIONS,
      fills: [
        fill({
          label: 'First Name',
          value: 'Test',
          locator: { attributes: { semantic: 'first_name' } },
        }),
        fill({
          label: 'Last Name',
          value: 'Candidate',
          locator: { attributes: { semantic: 'last_name' } },
        }),
        fill({ label: 'Email', value: 'test-candidate@test.invalid' }),
        fill({
          label: 'Are you authorized to work in the United States?',
          value: 'Yes',
          fieldType: 'SELECT',
        }),
      ],
    });
    expect(build.violations).toEqual([]);
    expect(
      build.input.personalInformation.find((p) => p.name === 'fullName')?.value
    ).toBe('Test Candidate');
  });

  it('never sends answer text as file answers and never invents EEO responses', () => {
    const build = buildLeverApplyInput({
      questions: QUESTIONS,
      fills: [
        fill({ label: 'Full name', value: 'Test Candidate' }),
        fill({ label: 'Email', value: 'test-candidate@test.invalid' }),
        fill({ label: 'Resume', value: SENTINEL, fieldType: 'FILE' }),
        fill({
          label: 'Are you authorized to work in the United States?',
          value: 'Yes',
          fieldType: 'SELECT',
        }),
      ],
      resumeFileName: 'approved-resume.pdf',
    });
    expect(build.warnings.some((w) => w.includes('file answer'))).toBe(true);
    expect(build.input.eeoResponses).toBeNull();
    expect(JSON.stringify(build.input)).not.toContain(SENTINEL);
  });

  it('attaches the approved resume only as the documented upload-uri reference', () => {
    const build = buildLeverApplyInput({
      questions: QUESTIONS,
      fills: [
        fill({ label: 'Full name', value: 'Test Candidate' }),
        fill({ label: 'Email', value: 'test-candidate@test.invalid' }),
        fill({
          label: 'Are you authorized to work in the United States?',
          value: 'Yes',
          fieldType: 'SELECT',
        }),
      ],
      resumeFileName: 'approved-resume.pdf',
    });
    const input = withLeverResumeUri(build.input, 'https://api.lever.co/v1/uploads/x-resume.pdf');
    expect(input.personalInformation.find((p) => p.name === 'resume')).toEqual({
      name: 'resume',
      value: 'https://api.lever.co/v1/uploads/x-resume.pdf',
    });
  });

  it('reports an ambiguous label match as a violation and never picks one', () => {
    const ambiguous: LeverApplyQuestions = {
      ...QUESTIONS,
      urls: [
        { name: 'LinkedIn', text: 'Website', type: 'text', required: false },
        { name: 'Other Website', text: 'Website', type: 'text', required: true },
      ],
    };
    const build = buildLeverApplyInput({
      questions: ambiguous,
      fills: [
        fill({ label: 'Full name', value: 'Test Candidate' }),
        fill({ label: 'Email', value: 'test-candidate@test.invalid' }),
        fill({ label: 'Website', value: 'https://example.com/test-candidate' }),
        fill({
          label: 'Are you authorized to work in the United States?',
          value: 'Yes',
          fieldType: 'SELECT',
        }),
      ],
    });
    // Ambiguity is a violation only when a required field cannot be
    // grounded; the ambiguous answer is never sent to either field.
    expect(build.violations.some((v) => v.problem.includes('never guessed'))).toBe(true);
    expect(build.input.urls).toEqual([]);
  });

  it('emits empty values for unanswered optional custom fields so the documented order always matches', () => {
    const build = buildLeverApplyInput({
      questions: QUESTIONS,
      fills: [
        fill({ label: 'Full name', value: 'Test Candidate' }),
        fill({ label: 'Email', value: 'test-candidate@test.invalid' }),
        fill({
          label: 'Are you authorized to work in the United States?',
          value: 'Yes',
          fieldType: 'SELECT',
        }),
      ],
    });
    expect(build.input.customQuestions[0].fields).toEqual([
      { value: 'Yes' },
      { value: [] },
      { value: '' },
    ]);
    expect(build.violations).toEqual([]);
  });
});
