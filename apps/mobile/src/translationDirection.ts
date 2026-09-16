import type { TranslationDirection } from '@lang-tutor/core/api';

/**
 * A direction the learner chose by tapping the flip control, together with the
 * exact string they chose it for.
 *
 * The form is half of the pin rather than bookkeeping. A direction remembered
 * on its own is either forgotten by the next request — which is the bug this
 * file exists for: the label said Hebrew→English and the submit that followed
 * carried no direction at all, so the server detected again and the label
 * reverted — or remembered forever, which is worse: the next word typed would
 * be forced into whatever direction the last flip happened to leave behind,
 * with no way to reach detection again short of restarting the app.
 */
export type DirectionPin = { form: string; direction: TranslationDirection };

/** Two directions, which is what makes "the other one" total rather than a guess. */
export function oppositeOf(direction: TranslationDirection): TranslationDirection {
  return direction === 'he_en' ? 'en_he' : 'he_en';
}

/**
 * The `direction` a lookup of `query` must send: the pinned one when the pin was
 * made for this very string, and otherwise nothing at all — an absent direction
 * is the wire contract's "detect from the script", which is the right answer for
 * a string the learner has not overruled.
 *
 * Compared trimmed, because the trimmed form is what the request carries.
 */
export function directionFor(
  query: string,
  pin: DirectionPin | undefined,
): TranslationDirection | undefined {
  return pin && pin.form === query.trim() ? pin.direction : undefined;
}
