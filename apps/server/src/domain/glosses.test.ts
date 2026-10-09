import { describe, expect, it } from '@jest/globals';

import { splitTranslation, tidyGlossList } from './glosses';

// [stored translation, translation, alternatives]
const COMMA_LISTS: [string, string, string[]][] = [
  ['להימנע מ-, להתחמק מ-', 'להימנע מ-', ['להתחמק מ-']],
  ['שפל, נחות', 'שפל', ['נחות']],
  ['לבסס, להשתית', 'לבסס', ['להשתית']],
  ['בסיס, יסוד', 'בסיס', ['יסוד']],
  ['מאוד, נורא', 'מאוד', ['נורא']],
  ['ארור, מקולל', 'ארור', ['מקולל']],
  ['עקוב מדם, אלים', 'עקוב מדם', ['אלים']],
  ['מדמם, מלא דם', 'מדמם', ['מלא דם']],
  ['קומבינציה, צירוף', 'קומבינציה', ['צירוף']],
  ['שילוב, צירוף', 'שילוב', ['צירוף']],
  ['לשלב, לאחד', 'לשלב', ['לאחד']],
  ['לשלב, להכיל', 'לשלב', ['להכיל']],
  ['להלחין, לחבר', 'להלחין', ['לחבר']],
  ['להרכיב, להוות', 'להרכיב', ['להוות']],
  ['לפתח, לבנות', 'לפתח', ['לבנות']],
  ['לפתח, לרכוש', 'לפתח', ['לרכוש']],
  ['לפתח, ליצור', 'לפתח', ['ליצור']],
  ['רם, חזק', 'רם', ['חזק']],
  ['ראשי, עיקרי', 'ראשי', ['עיקרי']],
  ['צינור ראשי, קו ראשי', 'צינור ראשי', ['קו ראשי']],
  ['להורות, לפקוד', 'להורות', ['לפקוד']],
  ['להשתפר, להתאושש', 'להשתפר', ['להתאושש']],
  ['לקלוט, ללמוד', 'לקלוט', ['ללמוד']],
  ['ראוותנות, מהומה, בלבול', 'ראוותנות', ['מהומה', 'בלבול']],
  ['לבלבל, להרשים בראוותנות', 'לבלבל', ['להרשים בראוותנות']],
  ['לזנק, לעלות בחדות', 'לזנק', ['לעלות בחדות']],
  ['לקבע במסמרים, לתקוע יתד', 'לקבע במסמרים', ['לתקוע יתד']],
  ['לסרב, לדחות', 'לסרב', ['לדחות']],
  ['להנמיך, להפחית', 'להנמיך', ['להפחית']],
  ['טוב, בסדר', 'טוב', ['בסדר']],
];

const PARENTHETICALS: [string, string, string[]][] = [
  ['בסיס (צבאי)', 'בסיס', []],
  ['בסיס (כימיה)', 'בסיס', []],
  ['אח (במסדר דתי)', 'אח', []],
  ['להנחית (כדור בווֹליבול)', 'להנחית', []],
  ['כבד, עשיר (בטעמים)', 'כבד', ['עשיר']],
  // A slash inside the parenthetical must not split.
  ['עמוק, עשיר (בגוון/צליל)', 'עמוק', ['עשיר']],
  ['לסמם (משקה), להוסיף חומר (למשקה)', 'לסמם', ['להוסיף חומר']],
  // A comma inside the parenthetical must not split either.
  ['אח (חבר, רע)', 'אח', []],
];

const WHOLE = ['בית קפה', 'עיר בירה', 'כלי נגינה', 'בלתי אפשרי', 'כיכר תנועה', 'תות שדה', 'בוקר טוב', 'יש לי', 'חסר השכלה', 'לרדת גשם זלעפות', 'to deposit', 'ha scritto'];

describe('splitTranslation', () => {
  it.each([...COMMA_LISTS, ...PARENTHETICALS])('%s', (stored, translation, alternatives) => {
    expect(splitTranslation(stored)).toEqual({ translation, alternatives });
  });

  it.each(WHOLE)('keeps the compound %s whole', (stored) => {
    expect(splitTranslation(stored)).toEqual({ translation: stored, alternatives: [] });
  });

  it('splits on a slash and a semicolon as the sense matcher does', () => {
    expect(splitTranslation('א, ב / ג')).toEqual({ translation: 'א', alternatives: ['ב', 'ג'] });
    expect(splitTranslation('א; ב')).toEqual({ translation: 'א', alternatives: ['ב'] });
  });

  it('drops a repeat of the translation or of another alternative', () => {
    expect(splitTranslation('רם, רָם, חזק, חזק')).toEqual({ translation: 'רם', alternatives: ['חזק'] });
  });

  it('never returns an empty translation', () => {
    expect(splitTranslation('(הערה)')).toEqual({ translation: '(הערה)', alternatives: [] });
  });
});

describe('tidyGlossList', () => {
  it('keeps the first of each key, never the main word, at most the cap', () => {
    expect(tidyGlossList([' רכב ', 'אוטו', 'מכונית', 'רֶכֶב', 'א', 'ב', 'ג', 'ד'], 'מכונית')).toEqual(['רכב', 'אוטו', 'א', 'ב', 'ג']);
  });
});
