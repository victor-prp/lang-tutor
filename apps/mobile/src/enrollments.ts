import type { Enrollment, LanguageCode } from '@lang-tutor/core/api';

/**
 * Pure enrollment rules for the app. Kept out of the hooks so they are tested
 * without rendering anything.
 */

/** What a learner can enroll in today: every enrollment is Hebrew-explained,
 *  so Hebrew itself is not on offer. */
export const ENROLLABLE_TARGETS: readonly LanguageCode[] = ['en', 'ru', 'it'];

const KNOWN: readonly LanguageCode[] = ['he', 'en', 'ru', 'it'];

/** The wire sends language codes as plain strings; requests need the enum. */
export function asLanguageCode(code: string): LanguageCode {
  if (!(KNOWN as readonly string[]).includes(code)) throw new Error(`unknown language ${code}`);
  return code as LanguageCode;
}

/**
 * The remembered enrollment if it is still held, else the newest. The list
 * arrives newest first. A remembered id that is gone — another device, a
 * reseeded server — is a convenience that expired, never an error.
 */
export function chooseActive(list: Enrollment[], rememberedId: string | null): Enrollment | null {
  return list.find((enrollment) => enrollment.id === rememberedId) ?? list[0] ?? null;
}

export function availableTargets(list: Enrollment[]): LanguageCode[] {
  const taken = new Set(list.map((enrollment) => enrollment.target_language));
  return ENROLLABLE_TARGETS.filter((code) => !taken.has(code));
}

export type LookupDirection = { from: LanguageCode; to: LanguageCode };

/** The translate screen opens on target → source: "I met this word". */
export function lookupDirection(pair: { source_language: string; target_language: string }): LookupDirection {
  return {
    from: asLanguageCode(pair.target_language),
    to: asLanguageCode(pair.source_language),
  };
}

export function flipped(direction: LookupDirection): LookupDirection {
  return { from: direction.to, to: direction.from };
}
