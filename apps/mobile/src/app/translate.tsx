import type { TranslationSense } from '@lang-tutor/core/api';
import { router } from 'expo-router';
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

import { useTranslation } from '@/hooks/useTranslation';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function TranslateScreen() {
  const t = useTranslation();
  const tooLong = t.text.trim().length > 100;
  const canSubmit = t.text.trim().length > 0 && !tooLong && t.status !== 'loading';

  // A sentence has one translation rather than competing senses, so it gets
  // neither `more` nor a save button. Withholding the save is deliberate: a
  // sentence is already known not to belong in a vocabulary, and offering to
  // save one would promise the single behaviour that is not coming.
  const isSentence = t.result?.kind === 'sentence';
  const senses = t.result?.senses ?? [];
  const visible = isSentence || t.revealed ? senses : senses.slice(0, 1);
  const hidden = senses.length - visible.length;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="translate-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text style={styles.title}>{strings.translateTitle}</Text>
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
        onPress={t.submit}
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
          <Pressable accessibilityRole="button" testID="translate-retry" onPress={t.submit}>
            <Text style={styles.link}>{strings.translateRetry}</Text>
          </Pressable>
        </View>
      ) : null}

      {t.status === 'empty' ? (
        <View testID="translate-empty" style={styles.notice}>
          <Text style={styles.noticeText}>{strings.translateEmpty}</Text>
        </View>
      ) : null}

      {t.status === 'answered' && t.result ? (
        <ScrollView contentContainerStyle={styles.results}>
          <View style={styles.directionRow}>
            <Text style={styles.directionLabel}>
              {strings.translateDirection(t.result.direction)}
            </Text>
            <Pressable accessibilityRole="button" testID="translate-flip" onPress={t.flip}>
              <Text style={styles.link}>{strings.translateFlip}</Text>
            </Pressable>
          </View>

          {visible.map((sense, index) => (
            <SenseCard
              key={`${sense.translation}-${index}`}
              sense={sense}
              isTop={index === 0 && !isSentence}
              chosen={t.chosenIndex === index}
              showChoose={!isSentence && t.chosenIndex === null}
              onChoose={() => t.choose(index)}
            />
          ))}

          {!isSentence && hidden > 0 && t.chosenIndex === null ? (
            <Pressable
              accessibilityRole="button"
              testID="translate-more"
              onPress={t.reveal}
              style={styles.moreButton}
            >
              <Text style={styles.moreLabel}>{strings.translateMore(hidden)}</Text>
            </Pressable>
          ) : null}

          {t.chosenIndex !== null ? (
            <Pressable
              accessibilityRole="button"
              testID="translate-new-word"
              onPress={t.reset}
              style={styles.moreButton}
            >
              <Text style={styles.moreLabel}>{strings.translateNewWord}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

function SenseCard({
  sense,
  isTop,
  chosen,
  showChoose,
  onChoose,
}: {
  sense: TranslationSense;
  isTop: boolean;
  chosen: boolean;
  showChoose: boolean;
  onChoose: () => void;
}) {
  const partOfSpeech = sense.part_of_speech
    ? strings.partOfSpeech(sense.part_of_speech)
    : undefined;

  return (
    <View style={[styles.card, isTop && styles.cardTop, chosen && styles.cardChosen]}>
      {isTop ? <Text style={styles.badge}>{strings.translateTopSense}</Text> : null}
      <Text style={styles.translation}>{sense.translation}</Text>
      {partOfSpeech ? <Text style={styles.partOfSpeech}>{partOfSpeech}</Text> : null}

      {sense.example ? (
        <View style={styles.example}>
          <Text style={styles.exampleSource}>{sense.example.source}</Text>
          <Text style={styles.exampleTarget}>{sense.example.target}</Text>
        </View>
      ) : null}

      {chosen ? (
        <Text testID="translate-chosen" style={styles.chosenLabel}>
          {strings.translateChosen}
        </Text>
      ) : null}

      {/* The card's own button selects it, not the card body: these cards are
          read and compared, and a tap-anywhere card turns reading into
          accidental choosing. */}
      {showChoose ? (
        <Pressable
          accessibilityRole="button"
          testID="translate-choose"
          onPress={onChoose}
          style={styles.chooseButton}
        >
          <Text style={styles.chooseLabel}>{strings.translateChoose}</Text>
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
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  cardTop: { borderColor: colors.primary, borderWidth: 2 },
  cardChosen: {
    borderColor: colors.correct,
    borderWidth: 2,
    backgroundColor: colors.correctSurface,
  },
  badge: {
    color: colors.primary,
    fontSize: fontSizes.sm,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  translation: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
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
    writingDirection: 'rtl',
  },
  chosenLabel: {
    marginTop: spacing.sm,
    color: colors.correct,
    fontSize: fontSizes.sm,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  chooseButton: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  chooseLabel: { color: colors.onPrimary, fontSize: fontSizes.sm, fontWeight: '700' },
  moreButton: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  moreLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
