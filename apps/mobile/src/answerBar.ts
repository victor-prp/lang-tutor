/**
 * The typed card's answer bar, which rides on the keyboard (answer bar spec D2):
 * the one line above its input, and its big button.
 */

/** What the line above the input says, if anything. */
export type BarNote = 'wrong_script' | 'word_only' | 'failed' | 'retype' | 'retype_again' | null;

/**
 * A refusal of what was just sent comes first: it is the newest. Then a check the
 * server could not make, once nothing is out; a retype asks for its word instead.
 * `retypeAttempt` is null while no retype is open.
 */
export function barNote(s: {
  refused: 'wrong_script' | 'word_only' | null;
  failed: boolean;
  checking: boolean;
  retypeAttempt: number | null;
}): BarNote {
  if (s.refused !== null) return s.refused;
  if (s.retypeAttempt !== null) return s.retypeAttempt === 1 ? 'retype' : 'retype_again';
  if (s.failed && !s.checking) return 'failed';
  return null;
}

/**
 * The big button: בדיקה, locked while a judged answer is out, and נסו שוב once
 * that check failed (spec D2, my call), which sends what is in the box again.
 */
export function barButton(s: { empty: boolean; checking: boolean; failed: boolean; retyping: boolean }): {
  label: 'check' | 'checking' | 'try_again';
  testID: 'typed-submit' | 'judge-try-again';
  disabled: boolean;
} {
  if (s.checking) return { label: 'checking', testID: 'typed-submit', disabled: true };
  if (s.failed && !s.retyping) return { label: 'try_again', testID: 'judge-try-again', disabled: s.empty };
  return { label: 'check', testID: 'typed-submit', disabled: s.empty };
}
