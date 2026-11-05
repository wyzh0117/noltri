import { describe, expect, it } from 'vitest';
import { noteInterpretationRequestSchema } from '../src/api';

describe('note interpretation request schema', () => {
  it('rejects empty and whitespace-only input without changing valid source text', () => {
    const whitespaceOnly = String.fromCharCode(32, 9, 13, 10, 32);
    expect(noteInterpretationRequestSchema.safeParse({ mode: 'translation', sourceText: '' }).success).toBe(false);
    expect(noteInterpretationRequestSchema.safeParse({ mode: 'translation', sourceText: whitespaceOnly }).success).toBe(false);

    const sourceText = '  Preserve original spacing.' + String.fromCharCode(10);
    expect(noteInterpretationRequestSchema.parse({ mode: 'explanation', sourceText }).sourceText).toBe(sourceText);
  });

  it('accepts the configured character limit and rejects the first character beyond it', () => {
    expect(noteInterpretationRequestSchema.safeParse({ mode: 'explanation', sourceText: 'x'.repeat(20_000) }).success).toBe(true);
    expect(noteInterpretationRequestSchema.safeParse({ mode: 'explanation', sourceText: 'x'.repeat(20_001) }).success).toBe(false);
  });
});


describe('source-grounded note questions', () => {
  it('accepts an explicit bounded question without changing source or question spacing', () => {
    const sourceText = '  A tuple is immutable.\n';
    const question = '  What remains fixed?  ';
    expect(noteInterpretationRequestSchema.parse({ mode: 'question', sourceText, question })).toEqual({ mode: 'question', sourceText, question });
    expect(noteInterpretationRequestSchema.safeParse({ mode: 'question', sourceText, question: 'x'.repeat(2000) }).success).toBe(true);
  });

  it.each([undefined, '', ' \t\n ', 'x'.repeat(2001)])('rejects a missing, blank or oversized question', (question) => {
    expect(noteInterpretationRequestSchema.safeParse({ mode: 'question', sourceText: 'Source.', ...(question === undefined ? {} : { question }) }).success).toBe(false);
  });

  it.each(['translation', 'explanation'])('rejects a question field outside question mode (%s)', (mode) => {
    expect(noteInterpretationRequestSchema.safeParse({ mode, sourceText: 'Source.', question: 'What does this say?' }).success).toBe(false);
    expect(noteInterpretationRequestSchema.safeParse({ mode, sourceText: 'Source.' }).success).toBe(true);
  });
});
