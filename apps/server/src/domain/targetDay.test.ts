import { describe, expect, it } from '@jest/globals';

import type { Dimension, QuestionType, ReadinessKind } from '@lang-tutor/core/domain';

import { servedSkill, targetDay, type SkillStart, type TargetDayInput, type TargetWordInput } from './targetDay';

// Phase 67 (spec D1–D4). A target's day from readiness at the start of the day: two cards a day for
// each word below 90 on two different skills, one per counted skill on the eve and a check for a
// ready word, new words split at most 8 a day. Pure: the day, the chances and the cards are passed in.

const LIVE: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spelling', 'spoken_productive'];
/** A word the device cannot say. */
const SILENT: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spelling'];
const W: Dimension = 'written_productive';
const S: Dimension = 'spelling';
const SAY: Dimension = 'spoken_productive';
const HOMEWORK: readonly Dimension[] = [W, S, SAY];

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const D0 = '2026-11-01';
const id = (i: number) => `g${String(i).padStart(2, '0')}`;

const word = (i: number, over: Partial<TargetWordInput> = {}): TargetWordInput => ({ glossId: id(i), addedOn: D0, startedOn: null, live: LIVE, ...over });
const words = (n: number, over: (i: number) => Partial<TargetWordInput> = () => ({})) => Array.from({ length: n }, (_, i) => word(i, over(i)));
/** Every counted skill of `glossIds` at `chance`, last moved on `movedOn`. */
const starts = (glossIds: readonly string[], chance: number, dims: readonly Dimension[] = HOMEWORK, movedOn: string | null = null): SkillStart[] =>
  glossIds.flatMap((glossId) => dims.map((dimension) => ({ glossId, dimension, chance, movedOn })));
const asked = (glossId: string, ...types: QuestionType[]) => types.map((type) => ({ glossId, type }));

/** A homework created on D0, due in `days`, read on day `on` of it. */
const day = (days: number, on: number, over: Partial<TargetDayInput> = {}, kind: ReadinessKind = 'homework') =>
  targetDay({
    today: addDays(D0, on),
    createdOn: D0,
    dueOn: addDays(D0, days),
    kind,
    words: [],
    starts: [],
    askedToday: [],
    answeredToday: false,
    ...over,
  });
const only = (d: ReturnType<typeof targetDay>, i: number) => d.words.find((w) => w.glossId === id(i))!;

describe('servedSkill (spec D2)', () => {
  it('reads the counted skill a card asks: writing, spelling or speaking, else none', () => {
    const types: QuestionType[] = ['typed_translation', 'cloze_typed', 'sentence_translation', 'letter_tiles', 'reverse_choice', 'cloze_choice'];
    for (const type of types) expect(servedSkill(type)).toBe(W);
    expect(servedSkill('dictation')).toBe(S);
    expect(servedSkill('say_translation')).toBe(SAY);
    for (const type of ['multiple_choice', 'typed_meaning', 'listen_choice', 'matching', 'meet', 'read_aloud', 'new_meaning'] as QuestionType[]) {
      expect(servedSkill(type)).toBeNull();
    }
  });
});

describe('targetDay: the cards a day owes (spec D1, D2)', () => {
  const met = words(1, () => ({ startedOn: D0 }));

  it('gives a word below 90 two cards before the eve, on its two weakest skills', () => {
    const d = day(5, 2, {
      words: met,
      starts: [
        { glossId: id(0), dimension: W, chance: 0.9, movedOn: null },
        { glossId: id(0), dimension: S, chance: 0.95, movedOn: null },
        { glossId: id(0), dimension: SAY, chance: 0.5, movedOn: null },
      ],
    });
    expect(only(d, 0)).toMatchObject({ state: 'owed', toStart: false, cardsLeft: 2, owed: [SAY, W], open: [SAY, W, S], readinessPct: 42 });
    expect(d.state).toBe('owed');
  });

  it('rests a ready word before the eve: no card, done, and the day a rest day', () => {
    const d = day(5, 2, { words: met, starts: starts([id(0)], 0.97) });
    expect(only(d, 0)).toMatchObject({ state: 'done', cardsLeft: 0, owed: [], readinessPct: 91 });
    expect(d.state).toBe('rest');
    expect(d.readyCount).toBe(1);
  });

  it('is done, not rest, once the path was practised today', () => {
    expect(day(5, 2, { words: met, starts: starts([id(0)], 0.97), answeredToday: true }).state).toBe('done');
  });

  it('asks every counted skill on the eve of a word below 90: three for homework', () => {
    const d = day(5, 4, { words: met, starts: starts([id(0)], 0.5) });
    expect(d.daysLeft).toBe(1);
    expect(only(d, 0)).toMatchObject({ cardsLeft: 3, owed: [W, S, SAY] });
  });

  it('asks an exam word every practised skill on the eve too: the kind sets how strict, never which skills are practised (phase 53 D3)', () => {
    const d = day(5, 4, { words: met, starts: starts([id(0)], 0.5) }, 'exam');
    expect(only(d, 0)).toMatchObject({ cardsLeft: 3, owed: [W, S, SAY] });
  });

  it("reads an exam word's readiness on writing and spelling alone, so a weak speaking skill does not hold it below 90", () => {
    const d = day(5, 2, {
      words: met,
      starts: [...starts([id(0)], 0.97, [W, S]), { glossId: id(0), dimension: SAY, chance: 0.2, movedOn: null }],
    }, 'exam');
    expect(only(d, 0)).toMatchObject({ readinessPct: 94, state: 'done', cardsLeft: 0, open: [SAY, W, S] });
  });

  it('asks two on the eve for a homework word that cannot be said (Review Focus 1)', () => {
    const d = day(5, 4, { words: words(1, () => ({ startedOn: D0, live: SILENT })), starts: starts([id(0)], 0.5, [W, S]) });
    expect(only(d, 0)).toMatchObject({ cardsLeft: 2, owed: [W, S], practised: [{ dimension: W, chance: 0.5 }, { dimension: S, chance: 0.5 }] });
  });

  it('practises spelling through the writing card on a device that cannot listen: no dictation, so no spelling card of its own (Review Focus 2)', () => {
    const deaf: Dimension[] = ['written_receptive', 'written_productive', 'spelling', 'spoken_productive'];
    const d = day(5, 4, { words: words(1, () => ({ startedOn: D0, live: deaf })), starts: starts([id(0)], 0.5) });
    expect(only(d, 0)).toMatchObject({ cardsLeft: 2, owed: [W, SAY], practised: [{ dimension: W, chance: 0.5 }, { dimension: SAY, chance: 0.5 }] });
    // Its readiness still counts spelling, which its typed answers grade.
    expect(only(d, 0).readinessPct).toBe(12);
  });

  it('checks a ready word once on the eve, on its weakest skill', () => {
    const d = day(5, 4, {
      words: met,
      starts: [...starts([id(0)], 0.99, [W, S]), { glossId: id(0), dimension: SAY, chance: 0.95, movedOn: null }],
    });
    expect(only(d, 0)).toMatchObject({ state: 'owed', cardsLeft: 1, owed: [SAY] });
  });

  it("checks a ready exam word on the eve on its weakest practised skill, speaking too (phase 53 D3)", () => {
    const d = day(5, 4, {
      words: met,
      starts: [
        { glossId: id(0), dimension: W, chance: 0.99, movedOn: null },
        { glossId: id(0), dimension: S, chance: 0.97, movedOn: null },
        { glossId: id(0), dimension: SAY, chance: 0.3, movedOn: null },
      ],
    }, 'exam');
    expect(only(d, 0)).toMatchObject({ state: 'owed', cardsLeft: 1, owed: [SAY] });
  });

  it('counts the cards asked today, right or wrong, one per skill: a typed and a say card leave nothing (Review Focus 3)', () => {
    const d = day(5, 2, { words: met, starts: starts([id(0)], 0.5), askedToday: asked(id(0), 'typed_translation', 'say_translation') });
    expect(only(d, 0)).toMatchObject({ state: 'done', cardsLeft: 0, owed: [], open: [S] });
  });

  it('counts two cards on one skill once: the second card asks another skill', () => {
    const d = day(5, 2, { words: met, starts: starts([id(0)], 0.5), askedToday: asked(id(0), 'typed_translation', 'cloze_typed') });
    expect(only(d, 0)).toMatchObject({ cardsLeft: 1, owed: [S], open: [S, SAY] });
  });

  it('ignores a card that asks no counted skill: a multiple choice leaves both cards owed', () => {
    const d = day(5, 2, { words: met, starts: starts([id(0)], 0.5), askedToday: asked(id(0), 'multiple_choice', 'meet') });
    expect(only(d, 0).cardsLeft).toBe(2);
  });

  it('breaks a tie of chances by the skill moved longest ago, never first, then writing, spelling, speaking', () => {
    const moved = day(5, 2, {
      words: met,
      starts: [
        { glossId: id(0), dimension: W, chance: 0.5, movedOn: addDays(D0, 1) },
        { glossId: id(0), dimension: S, chance: 0.5, movedOn: D0 },
        { glossId: id(0), dimension: SAY, chance: 0.5, movedOn: null },
      ],
    });
    expect(only(moved, 0).open).toEqual([SAY, S, W]);
    expect(only(day(5, 2, { words: met, starts: starts([id(0)], 0.5) }), 0).open).toEqual([W, S, SAY]);
  });

  it('reads a skill with no start as chance 0', () => {
    const d = day(5, 2, { words: met, starts: [{ glossId: id(0), dimension: W, chance: 0.8, movedOn: null }] });
    expect(only(d, 0)).toMatchObject({ owed: [S, SAY], readinessPct: 0 });
  });

  it('owes nothing on the due date: due_today', () => {
    const d = day(5, 5, { words: met, starts: starts([id(0)], 0.5) });
    expect(d.state).toBe('due_today');
    expect(only(d, 0).cardsLeft).toBe(0);
  });
});

describe('targetDay: new words, split (spec D3)', () => {
  const planned = (d: ReturnType<typeof targetDay>) => d.words.filter((w) => w.toStart).length;
  /** The first `n` of 15 words started on day `on`. */
  const firstStarted = (n: number, on: number) => words(15, (i) => (i < n ? { startedOn: addDays(D0, on) } : {}));

  it('meets 15 words given 5 days ahead 5, 5 and 5, by the halfway day', () => {
    expect(planned(day(5, 0, { words: words(15) }))).toBe(5);
    expect(planned(day(5, 1, { words: firstStarted(5, 0) }))).toBe(5);
    expect(planned(day(5, 2, { words: firstStarted(10, 0) }))).toBe(5);
  });

  it('meets them 8 then 7 given 2 days ahead: at most 8 a day (Victor)', () => {
    expect(planned(day(2, 0, { words: words(15) }))).toBe(8);
    expect(planned(day(2, 1, { words: firstStarted(8, 0) }))).toBe(7);
  });

  it('meets every one on the eve: homework due tomorrow', () => {
    expect(planned(day(1, 0, { words: words(15) }))).toBe(15);
  });

  it('counts the words started today toward the quota', () => {
    const d = day(5, 0, { words: firstStarted(3, 0), starts: starts([id(0), id(1), id(2)], 0.3) });
    expect(d.planned).toBe(5);
    expect(planned(d)).toBe(2);
    expect(d.words.filter((w) => w.state === 'later')).toHaveLength(10);
  });

  it('meets a word added past the halfway day at once (Review Focus 5)', () => {
    const list = [...words(15, () => ({ startedOn: D0 })), word(15, { addedOn: addDays(D0, 3) })];
    const d = day(5, 3, { words: list, starts: starts(list.slice(0, 15).map((w) => w.glossId), 0.97) });
    expect(only(d, 15)).toMatchObject({ state: 'owed', toStart: true, cardsLeft: 2 });
  });

  it('says when a later word starts: the day its quota first covers it', () => {
    const d = day(5, 0, { words: words(15) });
    expect(only(d, 5)).toMatchObject({ state: 'later', startsIn: 1 });
    expect(only(d, 14)).toMatchObject({ state: 'later', startsIn: 2 });
    expect(only(d, 4)).toMatchObject({ state: 'owed', startsIn: null });
  });

  it('calls a word practice more started today past the quota extra: it owes nothing more today', () => {
    const list = words(15, (i) => (i === 7 ? { startedOn: D0 } : {}));
    const d = day(5, 0, { words: list, starts: starts([id(7)], 0.3) });
    expect(only(d, 7)).toMatchObject({ state: 'extra', cardsLeft: 0 });
    expect(d.extra).toBe(1);
  });

  it('keeps known words already ready out of the quota before the eve: the others are met as if they were not there (final review 1)', () => {
    const d = day(5, 0, { words: words(15), starts: starts([0, 1, 2, 3, 4].map(id), 0.97) });
    for (const i of [0, 1, 2, 3, 4]) expect(only(d, i)).toMatchObject({ state: 'done', toStart: false, cardsLeft: 0 });
    // Ten words to meet over three days: ceil(10 / 3) = 4 today.
    expect(d.words.filter((w) => w.toStart).map((w) => w.glossId)).toEqual([5, 6, 7, 8].map(id));
    expect(d.state).toBe('owed');
    expect(d.planned).toBe(9);
  });

  it('rests a known word already ready on joining until the eve, which starts it by its check (Review Focus 4)', () => {
    const before = day(5, 0, { words: words(1), starts: starts([id(0)], 0.97) });
    expect(only(before, 0)).toMatchObject({ state: 'done', toStart: false, cardsLeft: 0 });
    const eve = day(5, 4, { words: words(1), starts: starts([id(0)], 0.97) });
    expect(only(eve, 0)).toMatchObject({ state: 'owed', toStart: true, cardsLeft: 1 });
  });
});

describe('targetDay: the day (spec D4)', () => {
  it('reads readiness and its ready words at the start of today', () => {
    const list = words(2, () => ({ startedOn: D0 }));
    const d = day(5, 2, { words: list, starts: [...starts([id(0)], 0.97), ...starts([id(1)], 0.5)] });
    // (0.9127 + 0.125) / 2.
    expect(d.readinessPct).toBe(51);
    expect(d.readyCount).toBe(1);
  });

  it('keeps the cap by days left for the meter', () => {
    expect(day(5, 3).capHalves).toBe(16);
  });

  it('practises tomorrow while a word is below 90 or not met yet', () => {
    expect(day(5, 2, { words: words(1, () => ({ startedOn: D0 })), starts: starts([id(0)], 0.5), answeredToday: true }).nextPracticeIn).toBe(1);
    expect(day(5, 0, { words: words(15) }).nextPracticeIn).toBe(1);
  });

  it('practises on the eve, for its check, when every word is ready', () => {
    expect(day(5, 1, { words: words(1, () => ({ startedOn: D0 })), starts: starts([id(0)], 0.97) }).nextPracticeIn).toBe(3);
  });

  it('has no next practice day from the eve on', () => {
    expect(day(5, 4, { words: words(1, () => ({ startedOn: D0 })), starts: starts([id(0)], 0.5) }).nextPracticeIn).toBeNull();
  });
});
