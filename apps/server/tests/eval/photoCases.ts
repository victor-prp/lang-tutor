import type { LanguageCode } from '@lang-tutor/core/api';

import type { MatchOption } from '../../src/domain/senseMatching';

/**
 * Phase 26. A photo and what reading it must find. `text` lists every accepted
 * spelling, because "to" and "the" before a phrase are dropped inconsistently
 * (spec, POC findings). `hebrew` is checked when given. Tier 1 (clean printed
 * pages): every item found and nothing extra. Tier 2: one check per expected
 * item, plus one failing check per extra item.
 */
export type PhotoCase = {
  label: string;
  file: string;
  language: LanguageCode;
  tier: 1 | 2;
  expect: { text: string[]; hebrew?: string }[];
};

const one = (text: string, hebrew?: string) => ({ text: [text], ...(hebrew ? { hebrew } : {}) });
const any = (texts: string[], hebrew?: string) => ({ text: texts, ...(hebrew ? { hebrew } : {}) });

export const PHOTO_CASES: PhotoCase[] = [
  {
    label: 'photo: printed Italian with Hebrew, articles dropped, heading and exercise skipped',
    file: 'it-printed-hebrew.jpg',
    language: 'it',
    tier: 1,
    expect: [
      one('casa', 'בית'), one('gatto', 'חתול'), one('finestra', 'חלון'), one('libro', 'ספר'),
      one('cucina', 'מטבח'), one('tavolo', 'שולחן'), one('sedia', 'כיסא'), one('aprire', 'לפתוח'),
      one('chiudere', 'לסגור'), any(['camera da letto', 'la camera da letto'], 'חדר שינה'),
      one('in bocca al lupo', 'בהצלחה'),
    ],
  },
  {
    label: 'photo: printed English in two columns, grammar labels dropped',
    file: 'en-printed-plain.jpg',
    language: 'en',
    tier: 1,
    expect: [
      one('run'), one('bank'), any(['look after', 'to look after']), one('kitchen'), one('window'),
      any(['borrow', 'to borrow']), one('although'), any(['weather', 'the weather']),
      any(['give up', 'to give up']), one('break a leg'),
    ],
  },
  {
    label: 'photo: printed Russian with stress marks and Hebrew',
    file: 'ru-printed-stress.jpg',
    language: 'ru',
    tier: 1,
    expect: [
      one('молоко', 'חלב'), one('окно', 'חלון'), one('книга', 'ספר'), one('собака', 'כלב'),
      one('говорить', 'לדבר'), one('красивый', 'יפה'), any(['как дела?', 'как дела'], 'מה שלומך?'),
      one('лук', 'בצל'),
    ],
  },
  {
    label: 'photo: Italian whiteboard, crossed-out word and date skipped',
    file: 'it-whiteboard.jpg',
    language: 'it',
    tier: 2,
    expect: [
      one('mare', 'ים'), one('spiaggia', 'חוף'), one('nuotare', 'לשחות'), one('sole', 'שמש'),
      one('sabbia', 'חול'), one('abbronzarsi', 'להשתזף'), any(['costume da bagno', 'il costume da bagno'], 'בגד ים'),
    ],
  },
  {
    label: 'photo: handwritten English notebook with Hebrew',
    file: 'en-handwritten-notebook.jpg',
    language: 'en',
    tier: 2,
    expect: [
      any(['borrow', 'to borrow'], 'ללוות'), any(['lend', 'to lend'], 'להשאיל'), one('although', 'למרות ש'),
      one('crowded', 'צפוף'), any(['give up', 'to give up'], 'לוותר'), any(['weather', 'the weather'], 'מזג אוויר'),
      one('bank', 'גדה'), any(['look after', 'to look after'], 'לטפל ב'), one('tired', 'עייף'),
    ],
  },
  {
    label: 'photo: handwritten Italian in two columns, no Hebrew',
    file: 'it-handwritten-plain.jpg',
    language: 'it',
    tier: 2,
    expect: [
      one('mela'), one('pane'), one('formaggio'), one('mangiare'), one('bere'),
      one('forchetta'), one('coltello'), one('bicchiere'), one('conto'), one('buon appetito'),
    ],
  },
  {
    label: 'photo: Russian page, only the boxed list is vocabulary',
    file: 'ru-page-noise.jpg',
    language: 'ru',
    tier: 2,
    expect: [
      one('улица', 'רחוב'), one('автобус', 'אוטובוס'), one('работа', 'עבודה'), one('рынок', 'שוק'),
      one('идти пешком', 'ללכת ברגל'),
    ],
  },
];

/**
 * Phase 26. The match call, asked only when no printed gloss equals a sense's
 * translation, so every case here is one the free check cannot settle. `expect`
 * is the 0-based option index, or 'none'.
 */
export type MatchCase = {
  label: string;
  word: string;
  target: LanguageCode;
  hebrew: string;
  options: MatchOption[];
  expect: number | 'none';
  tier: 1 | 2;
};

const noun = (translation: string): MatchOption => ({ translation, part_of_speech: 'noun' });
const verb = (translation: string): MatchOption => ({ translation, part_of_speech: 'verb' });

export const MATCH_CASES: MatchCase[] = [
  { label: 'match: a longer phrase names the river sense', word: 'bank', target: 'en', hebrew: 'גדת נהר', options: [noun('בנק'), noun('גדה')], expect: 1, tier: 1 },
  { label: 'match: the article does not hide the sense', word: 'casa', target: 'it', hebrew: 'הבית', options: [noun('בית'), noun('משפחה')], expect: 0, tier: 1 },
  { label: 'match: another gender is the same sense', word: 'stanca', target: 'it', hebrew: 'עייפה', options: [{ translation: 'עייף', part_of_speech: 'adjective' }], expect: 0, tier: 1 },
  { label: 'match: a bench is not a bank', word: 'banca', target: 'it', hebrew: 'ספסל', options: [noun('בנק')], expect: 'none', tier: 1 },
  { label: 'match: a bow is not an onion', word: 'лук', target: 'ru', hebrew: 'קשת', options: [noun('בצל')], expect: 'none', tier: 1 },
  { label: 'match: a synonym of the money sense', word: 'bank', target: 'en', hebrew: 'מוסד כספי', options: [noun('בנק'), noun('גדה')], expect: 0, tier: 2 },
  { label: 'match: a near-synonym verb', word: 'give up', target: 'en', hebrew: 'להתייאש', options: [verb('לוותר'), verb('להפסיק')], expect: 0, tier: 2 },
  { label: 'match: "not heavy" is the weight sense', word: 'light', target: 'en', hebrew: 'לא כבד', options: [noun('אור'), { translation: 'קל', part_of_speech: 'adjective' }, { translation: 'בהיר', part_of_speech: 'adjective' }], expect: 1, tier: 2 },
];
