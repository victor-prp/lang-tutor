import type { TranslationSense } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SpeakButton } from '@/components/SpeakButton';
import { useTranslation } from '@/hooks/useTranslation';
import { isVoiced } from '@/speech';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function TranslateScreen() {
  const t = useTranslation();
  if (!t.direction) return <Redirect href="/" />;
  const tooLong = t.text.trim().length > 100;
  const canSubmit = t.text.trim().length > 0 && !tooLong && t.status !== 'loading';

  // A sentence has one translation rather than competing senses, so it gets
  // neither a count line nor a save button. Withholding the save is deliberate:
  // a sentence is already known not to belong in a vocabulary, and offering to
  // save one would promise the single behaviour that is not coming.
  const isSentence = t.result?.kind === 'sentence';
  const senses = t.result?.senses ?? [];
  // Phase 23. The languages of the answer on screen, read from the response:
  // a flip changes t.direction without a new lookup. '' is never voiced.
  const answerFrom = t.result?.from ?? '';
  const answerTo = t.result?.to ?? '';
  // Every sense the one response carried, together. The whole reason to look up
  // a polysemous word is to compare its meanings, and the server already sent
  // them all — hiding the tail behind a tap charged an interaction for
  // information the client was holding. Only the ranking signal is kept: the
  // first card still says which meaning is the common one.
  const showCount = !isSentence && senses.length > 1;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="translate-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text style={styles.title}>{strings.translateTitle}</Text>
      </View>

      <View style={styles.directionRow}>
        <Text testID="translate-direction" style={styles.directionLabel}>
          {strings.translateDirection(t.direction.from, t.direction.to)}
        </Text>
        <Pressable accessibilityRole="button" testID="translate-flip" onPress={t.flip}>
          <Text style={styles.link}>{strings.translateFlip}</Text>
        </Pressable>
      </View>

      {/* NOT forced LTR. The username field pins writingDirection because a
          username is lowercase ASCII; this field takes either script, so it
          follows its content. Forcing a direction here puts the caret on the
          wrong side for every Hebrew lookup. */}
      <TextInput
        testID="translate-input"
        style={styles.input}
        value={t.text}
        onChangeText={t.setText}
        placeholder={strings.translatePlaceholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => canSubmit && t.submit()}
      />
      {tooLong ? <Text style={styles.fieldError}>{strings.translateTooLong}</Text> : null}

      <Pressable
        accessibilityRole="button"
        testID="translate-submit"
        disabled={!canSubmit}
        onPress={() => t.submit()}
        style={[styles.button, !canSubmit && styles.buttonDisabled]}
      >
        <Text style={styles.buttonLabel}>{strings.translateAction}</Text>
      </Pressable>

      {t.status === 'loading' ? (
        // A skeleton, not a progressive render: a structured JSON response
        // cannot be shown partially.
        <View testID="translate-loading" style={styles.skeleton}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}

      {t.status === 'error' ? (
        <View testID="translate-error" style={styles.notice}>
          <Text style={styles.noticeText}>{strings.translateUnavailable}</Text>
          <Pressable accessibilityRole="button" testID="translate-retry" onPress={() => t.submit()}>
            <Text style={styles.link}>{strings.translateRetry}</Text>
          </Pressable>
        </View>
      ) : null}

      {t.status === 'empty' ? (
        <View testID="translate-empty" style={styles.notice}>
          {/* The languages come from the answer, not from t.direction: the
              top flip changes the direction without a new lookup, and the
              notice describes the lookup that was refused. */}
          {t.result?.reason === 'wrong_direction' ? (
            <>
              <Text style={styles.noticeText}>
                {strings.translateWrongDirection(strings.languageName(t.result.to))}
              </Text>
              <Pressable
                accessibilityRole="button"
                testID="translate-flip-retry"
                onPress={t.flipAndRetry}
              >
                <Text style={styles.link}>{strings.translateFlipRetry}</Text>
              </Pressable>
            </>
          ) : t.result?.reason === 'out_of_pair' ? (
            <Text testID="translate-out-of-pair" style={styles.noticeText}>
              {strings.translateOutOfPair(strings.languageName(t.result.from))}
            </Text>
          ) : (
            <Text style={styles.noticeText}>{strings.translateEmpty}</Text>
          )}
        </View>
      ) : null}

      {t.status === 'answered' && t.result ? (
        <ScrollView contentContainerStyle={styles.results}>
          {/* Inside the `answered` branch, which makes one promise structural
              rather than a hope: `status` is `empty` whenever `senses` is empty,
              so an empty answer cannot render a banner even if one reached the
              wire. `zxqwbtl` still shows translateEmpty. */}
          {t.result.correction ? (
            <View testID="translate-correction" style={styles.correction}>
              <Text style={styles.correctionText}>
                {strings.translateCorrectionNotice(
                  t.result.text,
                  t.result.correction.corrected_form,
                )}
              </Text>

              {t.result.correction.alternatives.length > 0 ? (
                <View style={styles.alternatives}>
                  <Text style={styles.correctionText}>{strings.translateDidYouMean}</Text>
                  {t.result.correction.alternatives.map((alternative, index) => (
                    <Pressable
                      key={alternative}
                      accessibilityRole="button"
                      testID={`translate-alternative-${index}`}
                      // Both, and in this order: setText so the field agrees with
                      // the results, and the override so the request does not use
                      // the state value this render still holds.
                      onPress={() => {
                        t.setText(alternative);
                        t.submit(alternative);
                      }}
                      style={styles.alternativeChip}
                    >
                      <Text style={styles.alternativeLabel}>{alternative}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Phase 23 (spec §1 D4). What the senses describe, in the language being
              learned: the corrected form when there is one. It follows the
              response's languages, never t.direction, which a flip changes
              without a new lookup. A Hebrew → target lookup has no headword:
              its typed text is Hebrew, and each card's translation speaks. */}
          {isVoiced(t.result.from) ? (
            <View testID="translate-headword" style={styles.headword}>
              <Text style={styles.headwordText}>
                {t.result.correction?.corrected_form ?? t.result.text}
              </Text>
              <SpeakButton
                text={t.result.correction?.corrected_form ?? t.result.text}
                language={t.result.from}
                testID="speak-headword"
              />
            </View>
          ) : null}

          {showCount ? (
            <Text testID="translate-count" style={styles.senseCount}>
              {strings.translateSenseCount(senses.length)}
            </Text>
          ) : null}

          {t.canSaveAll ? (
            <Pressable
              accessibilityRole="button"
              testID="translate-save-all"
              onPress={t.saveAll}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>{strings.translateSaveAll}</Text>
            </Pressable>
          ) : null}
          {t.saveFailed ? (
            <Text testID="translate-save-failed" style={styles.noticeText}>
              {strings.translateSaveFailed}
            </Text>
          ) : null}

          {senses.map((sense, index) => (
            <SenseCard
              key={`${sense.translation}-${index}`}
              sense={sense}
              isTop={index === 0 && !isSentence}
              saveState={sense.sense_id ? t.saved[sense.sense_id] : undefined}
              pending={sense.sense_id ? Boolean(t.pending[sense.sense_id]) : false}
              onToggle={() => sense.sense_id && t.toggleSave(sense.sense_id)}
              from={answerFrom}
              to={answerTo}
            />
          ))}

          <Pressable
            accessibilityRole="button"
            testID="translate-new-word"
            onPress={t.reset}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryLabel}>{strings.translateNewWord}</Text>
          </Pressable>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

function SenseCard({
  sense,
  isTop,
  saveState,
  pending,
  onToggle,
  from,
  to,
}: {
  sense: TranslationSense;
  isTop: boolean;
  saveState: boolean | undefined;
  pending: boolean;
  onToggle: () => void;
  /** The response's languages: a translation is in `to`, an example in both. */
  from: string;
  to: string;
}) {
  const partOfSpeech = sense.part_of_speech
    ? strings.partOfSpeech(sense.part_of_speech)
    : undefined;

  return (
    <View testID="translate-sense" style={[styles.card, isTop && styles.cardTop]}>
      {isTop ? (
        <Text testID="translate-top-sense" style={styles.badge}>
          {strings.translateTopSense}
        </Text>
      ) : null}
      <View style={styles.spoken}>
        <Text style={[styles.translation, styles.grow, { writingDirection: strings.textDirection(to) }]}>
          {sense.translation}
        </Text>
        <SpeakButton text={sense.translation} language={to} testID="speak-translation" />
      </View>
      {partOfSpeech ? <Text style={styles.partOfSpeech}>{partOfSpeech}</Text> : null}

      {sense.example ? (
        <View style={styles.example}>
          {/* An example is written in `from` then `to`; whichever half is in
              the language being learned speaks. */}
          <View style={styles.spoken}>
            <Text style={[styles.exampleSource, styles.grow, { writingDirection: strings.textDirection(from) }]}>
              {sense.example.source}
            </Text>
            <SpeakButton text={sense.example.source} language={from} testID="speak-example" />
          </View>
          <View style={styles.spoken}>
            <Text style={[styles.exampleTarget, styles.grow, { writingDirection: strings.textDirection(to) }]}>
              {sense.example.target}
            </Text>
            <SpeakButton text={sense.example.target} language={to} testID="speak-example" />
          </View>
        </View>
      ) : null}

      {/* The card's own button saves it, not the card body: these cards are read
          and compared, and a tap-anywhere card turns reading into saving. */}
      {saveState !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: saveState, disabled: pending }}
          disabled={pending}
          testID="translate-save"
          onPress={onToggle}
          style={[styles.chooseButton, saveState && styles.savedButton]}
        >
          <Text style={[styles.chooseLabel, saveState && styles.savedLabel]}>
            {saveState ? strings.translateSaved : strings.translateSave}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    fontSize: fontSizes.md,
    color: colors.text,
  },
  fieldError: { color: colors.wrong, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: colors.onPrimary, fontSize: fontSizes.md, fontWeight: '700' },
  skeleton: {
    height: 140,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
  },
  noticeText: { color: colors.text, fontSize: fontSizes.md, writingDirection: 'rtl' },
  results: { gap: spacing.sm, paddingBottom: spacing.xl },
  directionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  directionLabel: { color: colors.muted, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  senseCount: { color: colors.muted, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  cardTop: { borderColor: colors.primary, borderWidth: 2 },
  badge: {
    color: colors.primary,
    fontSize: fontSizes.sm,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  // Direction comes from each line's language (strings.textDirection): a
  // translation and an example's halves are Hebrew in one lookup direction and
  // the target language in the other.
  translation: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
  },
  partOfSpeech: { color: colors.muted, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  example: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  exampleSource: { color: colors.text, fontSize: fontSizes.sm, lineHeight: lineHeights.sm },
  exampleTarget: {
    color: colors.muted,
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
  },
  chooseButton: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  chooseLabel: { color: colors.onPrimary, fontSize: fontSizes.sm, fontWeight: '700' },
  // Saved: an outlined button, so נשמר ✓ is primary on a light ground (white on
  // the near-white background would be unreadable).
  savedButton: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  savedLabel: { color: colors.primary },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  correction: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  correctionText: { color: colors.text, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  alternatives: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  alternativeChip: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  alternativeLabel: { color: colors.primary, fontSize: fontSizes.sm, fontWeight: '700' },
  headword: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headwordText: {
    flex: 1,
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
  },
  spoken: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  grow: { flex: 1 },
});
