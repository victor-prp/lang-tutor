import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { cardButton } from '@/components/BandCard';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

/**
 * Phase 69 (spec D5). One card of Words for me: the word, then the bar under it: the meaning
 * typed in Hebrew with בדיקה, or "אין לי מושג". After a typed answer the bar shows its verdict
 * and הבא instead. The bar sits under the scroll view, on the keyboard while it is up, and the
 * keyboard opens only when the learner taps the box (memory: android-keyboard-edge-to-edge).
 */
export function DiscoverCard({
  word,
  wordDirection,
  found,
  verdict,
  note,
  busy,
  canEnd,
  onCheck,
  onDontKnow,
  onNext,
  onEnd,
}: {
  word: string;
  wordDirection: 'rtl' | 'ltr';
  /** "נמצאו n מתוך goal מילים". */
  found: string;
  /** The verdict of a typed answer, shown until הבא. */
  verdict: { tone: 'right' | 'wrong'; text: string } | null;
  /** A refusal to show above the box: the answer was not in Hebrew. */
  note: string | null;
  busy: boolean;
  canEnd: boolean;
  onCheck: (text: string) => void;
  onDontKnow: () => void;
  onNext: () => void;
  onEnd: () => void;
}) {
  const [text, setText] = useState('');
  const blank = text.trim() === '';
  return (
    <>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.top}>
          <Text testID="discover-found" style={styles.found}>
            {found}
          </Text>
          {canEnd ? (
            <Pressable accessibilityRole="button" testID="discover-to-list" hitSlop={8} disabled={busy} onPress={onEnd}>
              <Text style={styles.toList}>{strings.discoverToList}</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.card}>
          <Text testID="discover-word" style={[styles.word, { writingDirection: wordDirection }]}>
            {word}
          </Text>
        </View>
      </ScrollView>
      <View style={styles.bar}>
        {verdict ? (
          <>
            <Text testID="discover-verdict" style={[styles.verdict, verdict.tone === 'right' ? styles.right : styles.wrong]}>
              {verdict.text}
            </Text>
            <Pressable accessibilityRole="button" testID="discover-next" onPress={onNext} style={cardButton.solid}>
              <Text style={cardButton.solidLabel}>{strings.discoverNext}</Text>
            </Pressable>
          </>
        ) : (
          <>
            {note ? (
              <Text testID="discover-note" style={styles.note}>
                {note}
              </Text>
            ) : null}
            <TextInput
              testID="discover-input"
              value={text}
              onChangeText={setText}
              placeholder={strings.discoverPlaceholder}
              placeholderTextColor={colors.muted}
              autoCorrect={false}
              spellCheck={false}
              autoCapitalize="none"
              returnKeyType="done"
              submitBehavior="submit"
              editable={!busy}
              onSubmitEditing={() => {
                if (!blank && !busy) onCheck(text);
              }}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              testID="discover-check"
              disabled={blank || busy}
              onPress={() => onCheck(text)}
              style={[cardButton.solid, (blank || busy) && cardButton.disabled]}
            >
              {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={cardButton.solidLabel}>{strings.discoverCheck}</Text>}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="discover-dont-know"
              disabled={busy}
              onPress={onDontKnow}
              style={[cardButton.pale, busy && cardButton.disabled]}
            >
              <Text style={cardButton.paleLabel}>{strings.discoverDontKnow}</Text>
            </Pressable>
          </>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, gap: spacing.md, paddingBottom: spacing.md },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  found: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  toList: { fontSize: fontSizes.sm, color: colors.primary, fontWeight: '700' },
  card: {
    flexGrow: 1,
    minHeight: 180,
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    ...shadows.card,
  },
  word: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, fontWeight: '800', color: colors.text, textAlign: 'center' },
  bar: { gap: spacing.sm, paddingVertical: spacing.sm },
  input: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSizes.lg,
    color: colors.text,
    writingDirection: 'rtl',
  },
  note: { fontSize: fontSizes.sm, color: colors.wrong, writingDirection: 'rtl' },
  verdict: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700', writingDirection: 'rtl', textAlign: 'center' },
  right: { color: colors.correct },
  wrong: { color: colors.amberText },
});
