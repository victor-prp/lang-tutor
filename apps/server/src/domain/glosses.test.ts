import { describe, expect, it } from '@jest/globals';

import { assignGlosses, keptEntry, mergeLevels, mergeSnapshots, splitTranslation, tidyGlossList } from './glosses';

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

const sense = (senseId: string, gloss: string, glossAlternatives: string[] = []) => ({ senseId, gloss, glossAlternatives });
const none = new Map<string, string>();

describe('assignGlosses (spec D6, D7)', () => {
  it('keeps an existing membership whatever this form says the sense is', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'מכרסם')],
      lemmaForm: false,
      glosses: [{ id: 'g1', key: 'עכבר', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan).toEqual({ create: [], join: [], alternatives: [], rename: [], needsMerge: false });
  });

  it('joins the gloss whose key is equal once normalised', () => {
    const plan = assignGlosses({ senses: [sense('s2', 'עַכְבָּר')], lemmaForm: false, glosses: [{ id: 'g1', key: 'עכבר', alternatives: [] }], memberships: none });
    expect(plan.join).toEqual([{ senseId: 's2', glossId: 'g1' }]);
    expect(plan.create).toEqual([]);
  });

  it('gives new senses with one key one new gloss, named by the lowest-ranked', () => {
    const plan = assignGlosses({ senses: [sense('s1', 'עכבר'), sense('s2', 'עַכְבָּר')], lemmaForm: true, glosses: [], memberships: none });
    expect(plan.create).toEqual([{ key: 'עכבר', alternatives: [], senseIds: ['s1', 's2'] }]);
  });

  it('keeps two senses that name each other among their alternatives apart: that would be a synonym merge', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'מדהים', ['נהדר']), sense('s2', 'נהדר', ['מדהים'])],
      lemmaForm: true,
      glosses: [],
      memberships: none,
    });
    expect(plan.create.map((g) => g.key)).toEqual(['מדהים', 'נהדר']);
  });

  it('makes three glosses out of five senses', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'פיתוח'), sense('s2', 'התפתחות'), sense('s3', 'פיתוח'), sense('s4', 'אירוע'), sense('s5', 'התפתחות')],
      lemmaForm: true,
      glosses: [],
      memberships: none,
    });
    expect(plan.create).toEqual([
      { key: 'פיתוח', alternatives: [], senseIds: ['s1', 's3'] },
      { key: 'התפתחות', alternatives: [], senseIds: ['s2', 's5'] },
      { key: 'אירוע', alternatives: [], senseIds: ['s4'] },
    ]);
  });

  it('unions alternatives into a gloss, never its key and never twice', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'מכונית', ['אוטו', 'מכונית', 'רֶכֶב'])],
      lemmaForm: false,
      glosses: [{ id: 'g1', key: 'מכונית', alternatives: ['רכב'] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan.alternatives).toEqual([{ glossId: 'g1', alternatives: ['רכב', 'אוטו'] }]);
  });

  it('lets the lemma form rename a key that no other gloss holds', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'אצבע')],
      lemmaForm: true,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan.rename).toEqual([{ glossId: 'g1', key: 'אצבע' }]);
    expect(plan.needsMerge).toBe(false);
  });

  it('never lets another form rename a key', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'אצבע')],
      lemmaForm: false,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan.rename).toEqual([]);
  });

  it('asks for a merge, not a rename, when another gloss holds the key', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'אצבע')],
      lemmaForm: true,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }, { id: 'g2', key: 'אצבע', alternatives: [] }],
      memberships: new Map([['s1', 'g1'], ['s2', 'g2']]),
    });
    expect(plan.rename).toEqual([]);
    expect(plan.needsMerge).toBe(true);
  });

  it('joins a new sense to a gloss this same write renamed', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'אצבע'), sense('s3', 'אצבע')],
      lemmaForm: true,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan.rename).toEqual([{ glossId: 'g1', key: 'אצבע' }]);
    expect(plan.join).toEqual([{ senseId: 's3', glossId: 'g1' }]);
  });

  // D7: one answer never leaves the merge job a pair to fold. The rename lands
  // first even when the new sense ranks above the member that makes it.
  it('joins a new sense to the gloss a lower-ranked member renames, and asks for no merge', () => {
    const plan = assignGlosses({
      senses: [sense('s3', 'אצבע'), sense('s1', 'אצבע')],
      lemmaForm: true,
      glosses: [{ id: 'g1', key: 'אצבעות', alternatives: [] }],
      memberships: new Map([['s1', 'g1']]),
    });
    expect(plan).toEqual({
      create: [],
      join: [{ senseId: 's3', glossId: 'g1' }],
      alternatives: [],
      rename: [{ glossId: 'g1', key: 'אצבע' }],
      needsMerge: false,
    });
  });

  // D6's own case: `difficult`'s second sense is קשה today and מסובך on another
  // day. Only the gloss's first member in the write decides its key; a later
  // member keeps its other word on its own rendering, whatever that word is.
  it("lets only a gloss's first member rename it: a later member's other word renames nothing and merges nothing", () => {
    const write = (glosses: { id: string; key: string; alternatives: string[] }[]) =>
      assignGlosses({
        senses: [sense('s1', 'קשה'), sense('s2', 'מסובך')],
        lemmaForm: true,
        glosses,
        memberships: new Map([['s1', 'g1'], ['s2', 'g1']]),
      });
    const unchanged = { create: [], join: [], alternatives: [], rename: [], needsMerge: false };
    expect(write([{ id: 'g1', key: 'קשה', alternatives: [] }])).toEqual(unchanged);
    // Not even when another gloss of the lexeme holds the later member's word.
    expect(write([{ id: 'g1', key: 'קשה', alternatives: [] }, { id: 'g2', key: 'מסובך', alternatives: [] }])).toEqual(unchanged);
  });

  it('counts a sense the answer names twice once, as its first occurrence', () => {
    const plan = assignGlosses({
      senses: [sense('s1', 'עכבר'), sense('s1', 'חולדה', ['מכרסם'])],
      lemmaForm: true,
      glosses: [],
      memberships: none,
    });
    expect(plan.create).toEqual([{ key: 'עכבר', alternatives: [], senseIds: ['s1'] }]);
  });
});

describe('folding two glosses (spec D3, D7)', () => {
  it('keeps the higher level and the later of each date', () => {
    expect(
      mergeLevels(
        { level: 3, lastStepOn: '2026-03-01', lastWrongOn: null },
        { level: 2, lastStepOn: '2026-03-05', lastWrongOn: '2026-03-04' },
      ),
    ).toEqual({ level: 3, lastStepOn: '2026-03-05', lastWrongOn: '2026-03-04' });
  });

  it('keeps the lowest level before and the highest after, so the snapshot check still holds', () => {
    expect(mergeSnapshots({ levelBefore: 2, levelAfter: 3 }, { levelBefore: 1, levelAfter: 2 })).toEqual({ levelBefore: 1, levelAfter: 3 });
  });

  it('keeps the earlier save, with its form and its adder', () => {
    const early = { variantId: 'v_fingers', addedByUserId: 'u_tutor', savedAt: '2026-01-01T00:00:00.000000' };
    const late = { variantId: 'v_finger', addedByUserId: 'u_1', savedAt: '2026-02-01T00:00:00.000000' };
    expect(keptEntry(late, early)).toBe(early);
    expect(keptEntry(early, late)).toBe(early);
  });
});

describe('assignGlosses after a merge (spec D7)', () => {
  it("joins a new sense whose key a merged gloss had to that gloss's survivor", () => {
    const plan = assignGlosses({
      senses: [sense('s9', 'אצבעות')],
      lemmaForm: false,
      glosses: [{ id: 'g_survivor', key: 'אצבע', alternatives: ['אצבעות'] }],
      memberships: new Map(),
      aliases: new Map([['אצבעות', 'g_survivor']]),
    });
    expect(plan.join).toEqual([{ senseId: 's9', glossId: 'g_survivor' }]);
    expect(plan.create).toEqual([]);
  });
});
