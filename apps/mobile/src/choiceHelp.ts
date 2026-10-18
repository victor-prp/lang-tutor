/**
 * Phase 63 (spec D7). Help on a choice card: each press rules out one wrong
 * option, never the right one, until two are left. Which one goes is fixed by
 * the card, not drawn (ADR 0002: no Math.random in the app), and not the same
 * screen position on every card: the wrong options in the order of a hash of
 * the card's id and their index.
 */
type Choice = { id: string; options: readonly string[]; correct_option: number };

/** FNV-1a, 32 bits: a stable order, not a secret. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The options `presses` presses of help have ruled out, by index. */
export function ruledOut(question: Choice, presses: number): number[] {
  const wrong = question.options.map((_, index) => index).filter((index) => index !== question.correct_option);
  const order = wrong.sort((a, b) => hash(`${question.id}:${a}`) - hash(`${question.id}:${b}`));
  return order.slice(0, Math.max(0, Math.min(presses, question.options.length - 2)));
}

/** Two options left: help has nothing more to rule out. */
export function choiceHelpDone(question: Choice, presses: number): boolean {
  return ruledOut(question, presses).length >= question.options.length - 2;
}
