import { describe, expect, it } from '@jest/globals';
import type { MyWordsToday } from '@lang-tutor/core/api';

import { hasToday, myWordsButton, todayDots, todayLine, todaySpoken, todayTiles } from '@/myWordsToday';

const ltr = (text: string) => `⁦${text}⁩`;
const today = (over: Partial<MyWordsToday> = {}): MyWordsToday => ({
  goal: 3,
  sessions_done: 0,
  new_words: 0,
  moved_up: 0,
  minutes: 15,
  ...over,
});

describe('todayLine (phase 73, spec D5)', () => {
  it('offers the goal with its minutes before the first session', () => {
    expect(todayLine(today())).toEqual({ text: `היעד של היום: ${ltr('3')} תרגולים`, side: `כ-${ltr('15')} דקות`, tone: 'plain' });
    expect(todayLine(today({ goal: 1 }))?.text).toBe('היעד של היום: תרגול אחד');
  });

  it('encourages while sessions are left', () => {
    expect(todayLine(today({ sessions_done: 1 }))).toEqual({ text: `כל הכבוד! עוד ${ltr('2')} תרגולים להיום`, side: null, tone: 'plain' });
    expect(todayLine(today({ sessions_done: 2 }))?.text).toBe('כל הכבוד! עוד תרגול אחד להיום');
  });

  it('says what was done once the goal is met, with the real count', () => {
    expect(todayLine(today({ sessions_done: 3 }))).toEqual({ text: `כל הכבוד! עשית ${ltr('3')} תרגולים היום`, side: null, tone: 'done' });
    expect(todayLine(today({ sessions_done: 4 }))?.text).toBe(`כל הכבוד! עשית ${ltr('4')} תרגולים היום`);
    expect(todayLine(today({ goal: 1, sessions_done: 1 }))?.text).toBe('כל הכבוד! עשית תרגול אחד היום');
  });

  it('is nothing with the goal off', () => {
    expect(todayLine(today({ goal: null, sessions_done: 2 }))).toBeNull();
  });
});

describe('todayDots', () => {
  it('draws done, todo and bonus', () => {
    expect(todayDots(today())).toEqual(['todo', 'todo', 'todo']);
    expect(todayDots(today({ sessions_done: 1 }))).toEqual(['done', 'todo', 'todo']);
    expect(todayDots(today({ sessions_done: 3 }))).toEqual(['done', 'done', 'done']);
    expect(todayDots(today({ sessions_done: 4 }))).toEqual(['done', 'done', 'done', 'bonus']);
    expect(todayDots(today({ goal: null, sessions_done: 4 }))).toEqual([]);
  });
});

describe('todayTiles', () => {
  it('is nothing when both are 0', () => {
    expect(todayTiles(today())).toBeNull();
  });

  it('labels in the plural', () => {
    expect(todayTiles(today({ new_words: 5, moved_up: 2 }))).toEqual({
      newWords: { count: 5, label: 'מילים חדשות היום' },
      movedUp: { count: 2, label: 'עלו רמה היום' },
    });
  });

  it('labels in the singular at 1', () => {
    expect(todayTiles(today({ new_words: 1, moved_up: 1 }))).toEqual({
      newWords: { count: 1, label: 'מילה חדשה היום' },
      movedUp: { count: 1, label: 'עלתה רמה היום' },
    });
  });

  it('shows both when one is 0, and with the goal off', () => {
    expect(todayTiles(today({ goal: null, moved_up: 2 }))?.newWords.count).toBe(0);
  });
});

describe('todaySpoken', () => {
  it('reads the line and the count the dots draw', () => {
    expect(todaySpoken(today({ sessions_done: 4 }))).toBe(
      `כל הכבוד! עשית ${ltr('4')} תרגולים היום, ${ltr('3')} מתוך ${ltr('3')} תרגולים היום ועוד ${ltr('1')} בונוס`,
    );
    expect(todaySpoken(today())).toBe(`היעד של היום: ${ltr('3')} תרגולים, כ-${ltr('15')} דקות`);
    expect(todaySpoken(today({ goal: null }))).toBe('');
  });
});

describe('myWordsButton', () => {
  it('is pale and says more once the goal is met', () => {
    expect(myWordsButton(today({ sessions_done: 3 }), { kind: 'start', sessionId: 's' })).toEqual({ label: 'לתרגל עוד', filled: false });
    expect(myWordsButton(today({ sessions_done: 5 }), { kind: 'resume', sessionId: 's' })).toEqual({ label: 'לתרגל עוד', filled: false });
  });

  it('is practise now, solid when it starts or resumes, before the goal', () => {
    expect(myWordsButton(today({ sessions_done: 1 }), { kind: 'start', sessionId: 's' })).toEqual({ label: 'לתרגל עכשיו', filled: true });
    expect(myWordsButton(undefined, { kind: 'create' })).toEqual({ label: 'לתרגל עכשיו', filled: false });
    expect(myWordsButton(today({ goal: null, sessions_done: 9 }), { kind: 'resume', sessionId: 's' })).toEqual({ label: 'לתרגל עכשיו', filled: true });
  });
});

describe('hasToday', () => {
  it('is false with the goal off and no tiles', () => {
    expect(hasToday(today({ goal: null }))).toBe(false);
  });
  it('is true with the goal off and a tile', () => {
    expect(hasToday(today({ goal: null, new_words: 2 }))).toBe(true);
    expect(hasToday(today({ goal: null, moved_up: 1 }))).toBe(true);
  });
  it('is true with the goal on', () => {
    expect(hasToday(today())).toBe(true);
  });
});
