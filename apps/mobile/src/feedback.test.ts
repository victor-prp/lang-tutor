import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { checksFit, feedbackFor, opensRetry, retryNotice, retryText } from './feedback';
import { strings } from './strings';

const choice: Question = {
  id: 'c',
  type: 'multiple_choice',
  vocab_term_id: 'l',
  question: 'casa',
  options: ['בית', 'דלת'],
  correct_option: 0,
  context: null,
};
const typed: Question = {
  id: 't',
  type: 'typed_translation',
  vocab_term_id: 'l',
  question: 'חלון',
  part_of_speech: 'noun',
  answer: 'finestra',
  lemma: 'finestra',
  alternatives: ['vetrata'],
  context: null,
};

describe('feedbackFor', () => {
  it('a right choice is correct, with no line', () => {
    expect(feedbackFor(choice, { option_index: 0 }, null)).toEqual({
      tone: 'correct',
      title: 'נכון!',
      line: null,
      verdict: null,
    });
  });

  it('a wrong choice shows the right answer', () => {
    expect(feedbackFor(choice, { option_index: 1 }, null)).toEqual({
      tone: 'wrong',
      title: 'התשובה הנכונה:',
      line: 'בית',
      verdict: null,
    });
  });

  it('an exact typed answer is correct, with no line', () => {
    expect(feedbackFor(typed, { text: 'Finestra' }, null)).toEqual({
      tone: 'correct',
      title: 'נכון!',
      line: null,
      verdict: 'exact',
    });
  });

  it('a near miss is correct and shows the spelling', () => {
    expect(feedbackFor(typed, { text: 'finestar' }, null)).toEqual({
      tone: 'correct',
      title: 'כמעט! כך כותבים:',
      line: 'finestra',
      verdict: 'near_miss',
    });
  });

  it('an alternative is correct and names the practised word', () => {
    expect(feedbackFor(typed, { text: 'vetrata' }, null)).toEqual({
      tone: 'correct',
      title: 'נכון! המילה שתרגלנו:',
      line: 'finestra',
      verdict: 'alternative',
    });
  });

  it('an empty answer ("show the answer") is wrong and shows the answer', () => {
    expect(feedbackFor(typed, { text: '' }, null)).toEqual({
      tone: 'wrong',
      title: 'התשובה הנכונה:',
      line: 'finestra',
      verdict: 'wrong',
    });
  });
});

describe('feedbackFor, phase 24', () => {
  const board: Question = {
    id: 'm1', type: 'matching', vocab_term_id: 'l', question: 'casa',
    options: ['בית', 'חתול', 'כלב', 'עץ', 'דלת'], correct_option: 0,
    board: { question_ids: ['m1', 'm2', 'm3', 'm4'], words: ['casa', 'gatto', 'cane', 'albero'], parts_of_speech: ['noun', 'noun', 'noun', 'noun'], correct_options: [0, 1, 2, 3] },
    part_of_speech: 'noun',
  };

  it('counts a board by first tries, correct only at all of them', () => {
    expect(feedbackFor(board, { board: [4, 1, 2, 3] }, null)).toEqual({
      tone: 'wrong', title: 'בניסיון הראשון: 3 מתוך 4', line: null, verdict: null,
    });
    expect(feedbackFor(board, { board: [0, 1, 2, 3] }, null).tone).toBe('correct');
  });

  it('names the heard form after a wrong dictation, and the meaning after a wrong listening card', () => {
    const dictation: Question = { id: 'd', type: 'dictation', vocab_term_id: 'l', question: 'parlo', meaning: 'מדבר' };
    expect(feedbackFor(dictation, { text: 'parlare' }, null)).toMatchObject({ tone: 'wrong', line: 'parlo' });
    const listen: Question = { id: 'l', type: 'listen_choice', vocab_term_id: 'l', question: 'casa', options: ['בית', 'דלת'], correct_option: 0, part_of_speech: 'noun' };
    expect(feedbackFor(listen, { option_index: 1 }, null)).toMatchObject({ tone: 'wrong', line: 'בית' });
  });
});

describe('phase 25 banners', () => {
  const READ: Question = { id: 'r', type: 'read_aloud', vocab_term_id: 'l', question: 'gatto', meaning: 'חתול' };
  const SAY: Question = {
    id: 's',
    type: 'say_translation',
    vocab_term_id: 'l',
    question: 'מדבר',
    part_of_speech: 'verb',
    answer: 'parlo',
    lemma: 'parlare',
    alternatives: ['dico'],
    context: null,
  };
  it('names what was heard when understood', () => {
    expect(feedbackFor(READ, { heard: 'il gatto', verdict: 'understood' }, null)).toEqual({
      tone: 'correct',
      title: strings.feedbackHeard,
      line: 'il gatto',
      verdict: 'understood',
    });
  });
  it('names the practised word for an alternative', () => {
    expect(feedbackFor(SAY, { heard: 'dico', verdict: 'alternative' }, null)).toEqual({
      tone: 'correct',
      title: strings.feedbackAlternative,
      line: 'parlo',
      verdict: 'alternative',
    });
  });
  it('takes the banner from the server verdict, never from its own judge', () => {
    // The app's judgeSpoken calls this unheard; the server said understood.
    expect(feedbackFor(READ, { heard: 'zzzz', verdict: 'understood' }, null)).toEqual({
      tone: 'correct',
      title: strings.feedbackHeard,
      line: 'zzzz',
      verdict: 'understood',
    });
    expect(feedbackFor(SAY, { heard: 'zzzz', verdict: 'alternative' }, null)).toMatchObject({ title: strings.feedbackAlternative });
  });
  it('shows the answer for show the answer, and judges a typed form as typed', () => {
    expect(feedbackFor(SAY, { pass: 'show_answer' }, null)).toMatchObject({ tone: 'wrong', title: strings.feedbackWrong, line: 'parlo' });
    expect(feedbackFor(SAY, { text: 'parlare' }, null)).toMatchObject({ tone: 'correct', verdict: 'exact' });
  });
});

describe('typed_meaning banners (phase 27 D12)', () => {
  const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין', context: null };
  it('a right answer as stored is just right', () => {
    expect(feedbackFor(MEANING, { text: 'לְהַזְמִין', judged: 'exact' }, null)).toEqual({ tone: 'correct', title: 'נכון!', line: null, verdict: 'exact' });
  });
  it('a right answer in other words shows the stored meaning', () => {
    expect(feedbackFor(MEANING, { text: 'לשריין', judged: 'exact' }, null)).toEqual({
      tone: 'correct',
      title: 'נכון! הפירוש השמור:',
      line: 'להזמין',
      verdict: 'exact',
    });
  });
  it('another sense names the meaning practised', () => {
    expect(feedbackFor(MEANING, { text: 'ספר', judged: 'alternative' }, null)).toEqual({
      tone: 'correct',
      title: 'נכון, אבל כאן תרגלנו:',
      line: 'להזמין',
      verdict: 'alternative',
    });
  });
  it('a wrong answer shows the meaning', () => {
    expect(feedbackFor(MEANING, { text: '', judged: 'wrong' }, null)).toEqual({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'להזמין', verdict: 'wrong' });
  });
});

describe('sentence cards (phase 27 D5, D6)', () => {
  const CHOICE: Question = {
    id: 'cc',
    type: 'cloze_choice',
    vocab_term_id: 'l',
    sentence: 'Ieri parlavamo per ore.',
    gap: { start: 5, end: 14 },
    translation: 'אתמול דיברנו שעות.',
    meaning: 'לדבר',
    options: ['parlavamo', 'parlano'],
    correct_option: 0,
  };
  const TYPED: Question = {
    id: 'ct',
    type: 'cloze_typed',
    vocab_term_id: 'l',
    sentence: 'Ieri parlavamo per ore.',
    gap: { start: 5, end: 14 },
    translation: 'אתמול דיברנו שעות.',
    meaning: 'לדבר',
    answer: 'parlavamo',
    alternatives: [],
    mark: null,
  };
  const TRANSLATE: Question = {
    id: 'st',
    type: 'sentence_translation',
    vocab_term_id: 'l',
    question: 'אתמול דיברנו שעות.',
    meaning: 'לדבר',
    sentence: 'Ieri parlavamo per ore.',
    gap: { start: 5, end: 14 },
    answer: 'parlavamo',
    mark: null,
  };

  it('a cloze choice is worded as a choice', () => {
    expect(feedbackFor(CHOICE, { option_index: 0 }, null)).toEqual({ tone: 'correct', title: 'נכון!', line: null, verdict: null });
    expect(feedbackFor(CHOICE, { option_index: 1 }, null)).toEqual({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'parlavamo', verdict: null });
  });

  it('a typed cloze is judged on the gap word', () => {
    expect(feedbackFor(TYPED, { text: 'parlavamo' }, null).title).toBe('נכון!');
    expect(feedbackFor(TYPED, { text: 'parlavano' }, null)).toMatchObject({ tone: 'correct', title: 'כמעט! כך כותבים:', line: 'parlavamo', verdict: 'near_miss' });
    expect(feedbackFor(TYPED, { text: 'parlare' }, null)).toMatchObject({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'parlavamo' });
  });

  it('a judged translation is worded per verdict, naming the practised word', () => {
    expect(feedbackFor(TRANSLATE, { text: 'Ieri parlavamo per ore.', judged: 'exact' }, null)).toEqual({
      tone: 'correct',
      title: 'נכון!',
      line: null,
      verdict: 'exact',
    });
    expect(feedbackFor(TRANSLATE, { text: 'Ieri parlavmo per ore.', judged: 'near_miss' }, null)).toEqual({
      tone: 'correct',
      title: 'כמעט! כך כותבים:',
      line: 'parlavamo',
      verdict: 'near_miss',
    });
    expect(feedbackFor(TRANSLATE, { text: 'Ieri dicevamo per ore.', judged: 'alternative' }, null)).toEqual({
      tone: 'correct',
      title: 'נכון! המילה שתרגלנו:',
      line: 'parlavamo',
      verdict: 'alternative',
    });
    expect(feedbackFor(TRANSLATE, { text: 'boh', judged: 'wrong' }, null)).toEqual({
      tone: 'wrong',
      title: 'התשובה הנכונה:',
      line: 'parlavamo',
      verdict: 'wrong',
    });
  });
});

describe('a second try (phase 34 D9)', () => {
  const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין', context: null };
  const SAY: Question = {
    id: 's',
    type: 'say_translation',
    vocab_term_id: 'l',
    question: 'מדבר',
    part_of_speech: 'verb',
    answer: 'parlo',
    lemma: 'parlare',
    alternatives: ['dico'],
    context: null,
  };
  const CLOZE: Question = {
    id: 'ct',
    type: 'cloze_typed',
    vocab_term_id: 'l',
    sentence: 'Ieri parlavamo per ore.',
    gap: { start: 5, end: 14 },
    translation: 'אתמול דיברנו שעות.',
    meaning: 'לדבר',
    answer: 'parlavamo',
    alternatives: ['chiacchieravamo'],
    mark: { start: 6, end: 12 },
  };
  const TRANSLATE: Question = {
    id: 'st',
    type: 'sentence_translation',
    vocab_term_id: 'l',
    question: 'בואו נשלב כוחות.',
    meaning: 'לשלב',
    sentence: 'Uniamo le forze.',
    gap: { start: 0, end: 6 },
    answer: 'Uniamo',
    mark: { start: 5, end: 9 },
  };

  it('says the first answer fits, then that another saved word is there', () => {
    expect(retryNotice('typed_translation', { answer: 'vetrata', wording: 'word' })).toEqual({
      right: '✓ נכון, ⁨vetrata⁩ מתאים כאן.',
      again: 'יש מילה נוספת ששמרת — נסו שוב',
    });
  });

  it('says another meaning is there on a typed meaning', () => {
    expect(retryNotice('typed_meaning', { answer: 'ספר', wording: 'meaning' })).toEqual({
      right: '✓ נכון, ⁨ספר⁩ מתאים כאן.',
      again: 'יש פירוש נוסף — נסו שוב',
    });
  });

  it('says on a typed gap that the word fits but another was meant (phase 38 D3)', () => {
    expect(retryNotice('cloze_typed', { answer: 'wasted', wording: 'word' })).toEqual({
      right: '✓ נכון, ⁨wasted⁩ מתאים כאן.',
      again: 'אבל התכוונו למילה אחרת — היעזרו במשפט בעברית ונסו שוב',
    });
  });

  it('clears the input, except a translation, which keeps its first sentence', () => {
    expect(retryText('typed_translation', { answer: 'vetrata', wording: 'word' })).toBe('');
    expect(retryText('typed_meaning', { answer: 'ספר', wording: 'meaning' })).toBe('');
    expect(retryText('sentence_translation', { answer: 'Combiniamo le forze.', wording: 'word' })).toBe('Combiniamo le forze.');
    expect(retryText('sentence_translation', null)).toBe('');
  });

  // Phase 41 (spec D3). The answers the server is asked to check against the gap.
  it('a typed gap answer the phone calls wrong is checked for a fit, and nothing else', () => {
    expect(checksFit(CLOZE, { text: 'cantavamo' })).toBe(true);
    for (const text of ['parlavamo', 'parlavmo', 'chiacchieravamo', '', '  ']) expect(checksFit(CLOZE, { text })).toBe(false);
    expect(checksFit(typed, { text: 'porta' })).toBe(false);
    expect(checksFit(CLOZE, { pass: 'show_answer' })).toBe(false);
  });

  it('a typed answer that is another accepted word opens it, on the cards that have one', () => {
    expect(opensRetry(typed, { text: 'vetrata' })).toBe(true);
    expect(opensRetry(SAY, { text: 'dico' })).toBe(true);
    expect(opensRetry(CLOZE, { text: 'chiacchieravamo' })).toBe(true);
  });

  it('no other answer the phone judges opens it', () => {
    expect(opensRetry(typed, { text: 'finestra' })).toBe(false);
    expect(opensRetry(typed, { text: 'finestar' })).toBe(false);
    expect(opensRetry(typed, { text: '' })).toBe(false);
    expect(opensRetry(typed, { text: 'porta' })).toBe(false);
    expect(opensRetry(choice, { option_index: 0 })).toBe(false);
    const dictation: Question = { id: 'd', type: 'dictation', vocab_term_id: 'l', question: 'parlo', meaning: 'מדבר' };
    expect(opensRetry(dictation, { text: 'parlo' })).toBe(false);
  });

  // Ruling R16, narrowed in phase 42 (spec D1). A second try given up leaves the
  // card where its first answer put it: right, another accepted word, and its
  // banner is that answer's, with the saved word. A wrong typed second try says so.
  const PENDING_WORD = { answer: 'vetrata', wording: 'word' } as const;
  const PENDING_MEANING = { answer: 'ספר', wording: 'meaning' } as const;
  const OTHER_WORD = { tone: 'correct', title: strings.feedbackAlternative, verdict: 'alternative' } as const;

  it('giving it up shows the banner of another accepted word, with the saved word', () => {
    // Typed cards, and the typed form of say the translation: empty text with retry.
    expect(feedbackFor(typed, { text: '' }, PENDING_WORD)).toEqual({ ...OTHER_WORD, line: 'finestra' });
    expect(feedbackFor(CLOZE, { text: '' }, PENDING_WORD)).toEqual({ ...OTHER_WORD, line: 'parlavamo' });
    expect(feedbackFor(SAY, { text: '' }, PENDING_WORD)).toEqual({ ...OTHER_WORD, line: 'parlo' });
    // Review Focus 2: blank is a give-up too; the server trims it to one.
    expect(feedbackFor(typed, { text: '  ' }, PENDING_WORD)).toEqual({ ...OTHER_WORD, line: 'finestra' });
    // Spoken: show the answer with retry.
    expect(feedbackFor(SAY, { pass: 'show_answer' }, PENDING_WORD)).toEqual({ ...OTHER_WORD, line: 'parlo' });
    // Judged: the server reports a given-up retry as wrong (ruling R15). A
    // translation names the practised word, a meaning card the meaning.
    expect(feedbackFor(TRANSLATE, { text: '', judged: 'wrong' }, PENDING_WORD)).toEqual({ ...OTHER_WORD, line: 'Uniamo' });
    expect(feedbackFor(MEANING, { text: '', judged: 'wrong' }, PENDING_MEANING)).toEqual({
      tone: 'correct',
      title: strings.feedbackOtherSense,
      line: 'להזמין',
      verdict: 'alternative',
    });
  });

  // Phase 42 (spec D1). The bug: יצירתיות, judged wrong, under "right, but here we practised".
  it('a wrong typed second try shows the right answer as wrong, so its input is marked wrong', () => {
    const wrong = (line: string) => ({ tone: 'wrong', title: strings.feedbackWrong, line, verdict: 'wrong' });
    expect(feedbackFor(typed, { text: 'porta' }, PENDING_WORD)).toEqual(wrong('finestra'));
    expect(feedbackFor(CLOZE, { text: 'cantavamo' }, PENDING_WORD)).toEqual(wrong('parlavamo'));
    expect(feedbackFor(SAY, { text: 'dormo' }, PENDING_WORD)).toEqual(wrong('parlo'));
    expect(feedbackFor(TRANSLATE, { text: 'Andiamo.', judged: 'wrong' }, PENDING_WORD)).toEqual(wrong('Uniamo'));
    expect(feedbackFor(MEANING, { text: 'לקרוא', judged: 'wrong' }, PENDING_MEANING)).toEqual(wrong('להזמין'));
  });

  // Phase 42 review I1, phase 45 review I1. The first answer sent again is still not
  // the word: neither red (it was just told it fits) nor green (it is the bug), and the
  // same on every card, typed or spoken, judged again or not.
  it('the first answer sent again says it is still not the word', () => {
    const still = (line: string) => ({ tone: 'other', title: strings.feedbackStillOther, line, verdict: null });
    expect(feedbackFor(CLOZE, { text: ' Cantavamo ' }, { answer: 'cantavamo', wording: 'word' })).toEqual(still('parlavamo'));
    expect(feedbackFor(typed, { text: 'vetrata' }, PENDING_WORD)).toEqual(still('finestra'));
    expect(feedbackFor(TRANSLATE, { text: 'Uniamo le forze', judged: 'wrong' }, { answer: 'Uniamo le forze.', wording: 'word' })).toEqual(still('Uniamo'));
    expect(feedbackFor(TRANSLATE, { text: 'Combiniamo le forze.', judged: 'alternative' }, { answer: 'Combiniamo le forze.', wording: 'word' })).toEqual(still('Uniamo'));
    expect(feedbackFor(MEANING, { text: 'סֵפֶר', judged: 'wrong' }, PENDING_MEANING)).toMatchObject({ tone: 'other', title: strings.feedbackStillOtherSense });
  });

  // Phase 45 (spec D1). Another accepted word again missed what the second try asked
  // for: not green, not red, and the input is not coloured.
  it('another accepted word on the second try says it is still not the word, uncoloured', () => {
    const still = (line: string) => ({ tone: 'other', title: strings.feedbackStillOther, line, verdict: null });
    expect(feedbackFor(typed, { text: 'vetrata' }, { answer: 'vetri', wording: 'word' })).toEqual(still('finestra'));
    expect(feedbackFor(CLOZE, { text: 'chiacchieravamo' }, { answer: 'cantavamo', wording: 'word' })).toEqual(still('parlavamo'));
    // Review Focus 2: say the translation, typed and heard.
    expect(feedbackFor(SAY, { text: 'dico' }, { answer: 'racconto', wording: 'word' })).toEqual(still('parlo'));
    expect(feedbackFor(SAY, { heard: 'dico', verdict: 'alternative' }, { answer: 'racconto', wording: 'word' })).toEqual(still('parlo'));
    expect(feedbackFor(TRANSLATE, { text: 'Combiniamo le forze.', judged: 'alternative' }, { answer: 'Uniamo i poteri.', wording: 'word' })).toEqual(still('Uniamo'));
    expect(feedbackFor(MEANING, { text: 'ספר', judged: 'alternative' }, { answer: 'מפה', wording: 'meaning' })).toEqual({
      tone: 'other',
      title: strings.feedbackStillOtherSense,
      line: 'להזמין',
      verdict: null,
    });
  });

  // Review Focus 1: a first answer that is another accepted word keeps its green banner.
  it('another accepted word as a first answer keeps its right banner', () => {
    expect(feedbackFor(typed, { text: 'vetrata' }, null)).toEqual({ ...OTHER_WORD, line: 'finestra' });
  });

  it('the saved word found on it gets the banner that answer gets today', () => {
    expect(feedbackFor(typed, { text: 'finestra' }, PENDING_WORD)).toEqual({ tone: 'correct', title: strings.feedbackCorrect, line: null, verdict: 'exact' });
    expect(feedbackFor(typed, { text: 'finestar' }, PENDING_WORD)).toEqual({ tone: 'correct', title: strings.feedbackNearMiss, line: 'finestra', verdict: 'near_miss' });
    expect(feedbackFor(SAY, { heard: 'parlo', verdict: 'understood' }, PENDING_WORD)).toEqual({
      tone: 'correct',
      title: strings.feedbackHeard,
      line: 'parlo',
      verdict: 'understood',
    });
    expect(feedbackFor(MEANING, { text: 'להזמין', judged: 'exact' }, PENDING_MEANING)).toEqual({ tone: 'correct', title: strings.feedbackCorrect, line: null, verdict: 'exact' });
  });

});

// Phase 55 (spec D6, D7). Help, or a wrong tile, makes a right answer a helped one.
describe('a helped answer (phase 55 D6, D7)', () => {
  const TILES: Question = {
    id: 'lt',
    type: 'letter_tiles',
    vocab_term_id: 'l',
    question: 'בית',
    part_of_speech: 'noun',
    answer: 'casa',
    tiles: ['c', 'a', 's', 'a', 'o', 'e'],
  };
  const HELPED = { tone: 'other', title: 'נכון, עם עזרה', line: null, verdict: null };

  it('right with help is right with help, on tiles and typed, with no line', () => {
    expect(feedbackFor(TILES, { text: 'casa', helped: true }, null)).toEqual(HELPED);
    expect(feedbackFor(typed, { text: 'finestra', helped: true }, null)).toEqual(HELPED);
    expect(feedbackFor(typed, { text: 'vetrata', helped: true }, null)).toEqual(HELPED);
    expect(strings.feedbackHelped).toBe('נכון, עם עזרה');
  });

  it('without help it is told as today', () => {
    expect(feedbackFor(TILES, { text: 'casa', helped: false }, null)).toEqual({ tone: 'correct', title: 'נכון!', line: null, verdict: 'exact' });
    expect(feedbackFor(typed, { text: 'finestra', helped: false }, null)).toEqual({ tone: 'correct', title: 'נכון!', line: null, verdict: 'exact' });
  });

  it('wrong with help is wrong, with the answer', () => {
    expect(feedbackFor(TILES, { text: '', helped: true }, null)).toEqual({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'casa', verdict: 'wrong' });
    expect(feedbackFor(typed, { text: 'porta', helped: true }, null)).toEqual({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'finestra', verdict: 'wrong' });
  });

  it('on a second try, the word with help is helped, and anything else is told as today', () => {
    const PENDING = { answer: 'vetrata', wording: 'word' } as const;
    expect(feedbackFor(typed, { text: 'finestra', helped: true }, PENDING)).toEqual(HELPED);
    expect(feedbackFor(typed, { text: 'vetri', helped: true }, { answer: 'vetrata', wording: 'word' })).toMatchObject({ tone: 'wrong' });
    expect(feedbackFor(typed, { text: '', helped: true }, PENDING)).toEqual({ tone: 'correct', title: strings.feedbackAlternative, line: 'finestra', verdict: 'alternative' });
    expect(feedbackFor(typed, { text: 'vetrata', helped: true }, { answer: 'vetri', wording: 'word' })).toMatchObject({ tone: 'other', title: strings.feedbackStillOther });
  });

  // Review M1. Core records a helped second try `wrong`, a near miss included, and no
  // retype follows a second try: its banner is the helped one, not "nearly". A first
  // try's near miss opens the retype, which shows that answer's own title.
  it('a helped near miss is helped on a second try, and keeps its title for the retype on a first', () => {
    expect(feedbackFor(typed, { text: 'finestar', helped: true }, { answer: 'vetrata', wording: 'word' })).toEqual(HELPED);
    expect(feedbackFor(typed, { text: 'finestar', helped: false }, { answer: 'vetrata', wording: 'word' })).toMatchObject({ tone: 'correct', verdict: 'near_miss' });
    expect(feedbackFor(typed, { text: 'finestar', helped: true }, null)).toEqual({ tone: 'correct', title: 'כמעט! כך כותבים:', line: 'finestra', verdict: 'near_miss' });
  });

  it('a retype that is open leaves the first answer’s banner; one that ended tells how', () => {
    expect(feedbackFor(typed, { text: 'finestar', helped: false }, null, { attempt: 1, showing: true, outcome: null })).toMatchObject({
      title: 'כמעט! כך כותבים:',
      line: 'finestra',
    });
    expect(feedbackFor(typed, { text: 'porta', helped: false }, null, { attempt: 2, showing: false, outcome: 'right' })).toEqual({
      tone: 'correct',
      title: 'נכון!',
      line: null,
      verdict: 'exact',
    });
    expect(feedbackFor(typed, { text: 'finestar', helped: true }, null, { attempt: 2, showing: false, outcome: 'failed' })).toEqual({
      tone: 'wrong',
      title: 'התשובה הנכונה:',
      line: 'finestra',
      verdict: 'wrong',
    });
  });
});

// Phase 56 (spec D8). A helped spoken or judged answer whose words were right is
// right with help; a helped wrong one is wrong.
describe('a helped answer on more cards (phase 56 D8)', () => {
  const HELPED = { tone: 'other', title: 'נכון, עם עזרה', line: null, verdict: null };
  const SAY: Question = { id: 's', type: 'say_translation', vocab_term_id: 'l', question: 'מדבר', part_of_speech: 'verb', answer: 'parlo', lemma: 'parlare', alternatives: ['dico'], context: null };
  const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין', context: null };
  const TRANSLATE: Question = { id: 'st', type: 'sentence_translation', vocab_term_id: 'l', question: 'בואו נשלב כוחות.', meaning: 'לשלב', sentence: 'Uniamo le forze.', gap: { start: 0, end: 6 }, answer: 'Uniamo', mark: null };
  const CLOZE: Question = {
    id: 'ct',
    type: 'cloze_typed',
    vocab_term_id: 'l',
    sentence: 'Ieri parlavamo per ore.',
    gap: { start: 5, end: 14 },
    translation: 'אתמול דיברנו שעות.',
    meaning: 'לדבר',
    answer: 'parlavamo',
    alternatives: ['chiacchieravamo'],
    mark: null,
  };
  const DICTATION: Question = { id: 'd', type: 'dictation', vocab_term_id: 'l', question: 'parlo', meaning: 'מדבר' };

  it('a spoken answer understood or another word, with help, is right with help', () => {
    expect(feedbackFor(SAY, { heard: 'parlo', verdict: 'understood', helped: true }, null)).toEqual(HELPED);
    expect(feedbackFor(SAY, { heard: 'dico', verdict: 'alternative', helped: true }, null)).toEqual(HELPED);
    expect(feedbackFor(SAY, { heard: 'parlo', verdict: 'understood', helped: false }, null)).toMatchObject({ tone: 'correct', verdict: 'understood' });
  });

  it('a judged answer the judge called right, with help, is right with help; a wrong one is wrong', () => {
    expect(feedbackFor(MEANING, { text: 'להזמין', judged: 'exact', helped: true }, null)).toEqual(HELPED);
    expect(feedbackFor(TRANSLATE, { text: 'Uniamo le forze.', judged: 'exact', helped: true }, null)).toEqual(HELPED);
    expect(feedbackFor(MEANING, { text: 'לבטל', judged: 'wrong', helped: true }, null)).toEqual({ tone: 'wrong', title: 'התשובה הנכונה:', line: 'להזמין', verdict: 'wrong' });
    expect(feedbackFor(MEANING, { text: 'להזמין', judged: 'exact', helped: true }, { answer: 'לשריין', wording: 'meaning' })).toEqual(HELPED);
  });

  it('a typed dictation or cloze with help is right with help', () => {
    expect(feedbackFor(DICTATION, { text: 'parlo', helped: true }, null)).toEqual(HELPED);
    expect(feedbackFor(CLOZE, { text: 'parlavamo', helped: true }, null)).toEqual(HELPED);
    expect(feedbackFor(SAY, { text: 'parlare', helped: true }, null)).toEqual(HELPED);
  });

  it('asks no fit check for a helped gap word', () => {
    expect(checksFit(CLOZE, { text: 'banana' })).toBe(true);
    expect(checksFit(CLOZE, { text: 'banana', helped: false })).toBe(true);
    expect(checksFit(CLOZE, { text: 'banana', helped: true })).toBe(false);
  });
});
