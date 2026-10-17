import { describe, expect, it } from '@jest/globals';
import { QuestionTypeSchema, UnavailableReasonSchema } from '@lang-tutor/core/api/schemas';

import { ApiError } from './api/client';
import { afterPreparing, initialSelection, pollPrepared, toggled } from './questionTypes';
import { strings } from './strings';

// Phase 61 (spec D2, D5, D6).
describe('question-type copy', () => {
  it('names every question type and every reason in Hebrew', () => {
    for (const type of QuestionTypeSchema.options) expect(strings.questionTypeName(type)).toMatch(/[֐-׿]/);
    for (const reason of UnavailableReasonSchema.options) expect(strings.questionTypeUnavailable(reason)).toMatch(/[֐-׿]/);
  });
});

describe('initialSelection', () => {
  it('ticks every available type and no other', () => {
    const types = [
      { type: 'meet' as const, available: true },
      { type: 'matching' as const, available: false, reason: 'needs_more_words' as const },
      { type: 'dictation' as const, available: true },
    ];
    expect([...initialSelection(types)]).toEqual(['meet', 'dictation']);
  });
});

describe('toggled', () => {
  it('adds a type that is not chosen and removes one that is, leaving the set it was given alone', () => {
    const chosen = new Set(['meet', 'dictation'] as const);
    expect([...toggled(chosen, 'meet')]).toEqual(['dictation']);
    expect([...toggled(chosen, 'read_aloud')]).toEqual(['meet', 'dictation', 'read_aloud']);
    expect([...chosen]).toEqual(['meet', 'dictation']);
  });
});

describe('afterPreparing', () => {
  it('waits while preparing, and fails a failed session with what was skipped', () => {
    expect(afterPreparing({ status: 'preparing' })).toEqual({ next: 'wait' });
    expect(afterPreparing({ status: 'failed', skipped_types: [{ type: 'cloze_typed', reason: 'not_generated' }] })).toEqual({
      next: 'failed',
      skipped: ['cloze_typed'],
    });
  });

  it('enters a ready session at once when nothing was skipped, and shows the skipped first otherwise', () => {
    expect(afterPreparing({ status: 'ready', skipped_types: [] })).toEqual({ next: 'enter' });
    expect(afterPreparing({ status: 'ready' })).toEqual({ next: 'enter' });
    expect(afterPreparing({ status: 'ready', skipped_types: [{ type: 'dictation', reason: 'not_generated' }] })).toEqual({
      next: 'show_skipped',
      skipped: ['dictation'],
    });
  });

  it('treats any other end as failed', () => {
    expect(afterPreparing({ status: 'skipped' })).toEqual({ next: 'failed', skipped: [] });
  });
});

// Final review (important 1). A dropped request is not the session failing: the poll goes on.
describe('pollPrepared', () => {
  const noWait = async () => {};
  const reads = (...answers: (Error | { status: 'preparing' | 'ready' | 'failed' })[]) => {
    let call = 0;
    return async () => {
      const answer = answers[Math.min(call++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    };
  };

  it('reads again after a failed request, until the session is ready', async () => {
    const outcome = await pollPrepared(reads({ status: 'preparing' }, new Error('network'), new ApiError(502), { status: 'ready' }), noWait, () => true);
    expect(outcome).toEqual({ next: 'enter' });
  });

  it('gives up on a refusal, which another read would only repeat', async () => {
    const outcome = await pollPrepared(reads({ status: 'preparing' }, new ApiError(404)), noWait, () => true);
    expect(outcome).toEqual({ next: 'failed', skipped: [] });
  });

  it('stops, answering nothing, once the screen is gone', async () => {
    let live = 2;
    const outcome = await pollPrepared(reads({ status: 'preparing' }), noWait, () => live-- > 0);
    expect(outcome).toBeNull();
  });
});
