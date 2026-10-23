import Ionicons from '@expo/vector-icons/Ionicons';
import type { DiscoveryRun } from '@lang-tutor/core/api';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { cardButton } from '@/components/BandCard';
import type { endStep } from '@/discovery';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

/**
 * Phase 74 (spec D9). The end of a run of Words for me: how many words were added, each with its
 * meaning (a word its lookup failed on, muted), and the session: started at once when it is
 * ready, a line while it is prepared, or a way back when there is none to offer.
 */
export function DiscoverEnd({
  run,
  wordDirection,
  step,
  busy,
  onStart,
  onHome,
}: {
  run: DiscoveryRun;
  wordDirection: 'rtl' | 'ltr';
  step: ReturnType<typeof endStep>;
  busy: boolean;
  onStart: () => void;
  onHome: () => void;
}) {
  const kept = run.added.filter((word) => word.status !== 'failed').length;
  return (
    <>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {kept > 0 ? (
          <View style={styles.hero}>
            <Text testID="discover-end-count" style={styles.count}>
              {kept}
            </Text>
            <Text style={styles.label}>{strings.discoverEndLabel(kept)}</Text>
          </View>
        ) : null}
        {run.added.length > 0 ? (
          <View style={styles.group}>
            {run.added.map((word, index) => (
              <View key={word.position} style={[styles.row, index < run.added.length - 1 && styles.hairline]}>
                {word.status === 'failed' ? (
                  <Text style={styles.failed}>{strings.discoverEndNotAdded(word.word)}</Text>
                ) : (
                  <>
                    <Text testID="discover-end-word" style={[styles.word, { writingDirection: wordDirection }]}>
                      {word.word}
                    </Text>
                    <Text style={styles.meaning}>{word.meaning}</Text>
                  </>
                )}
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
      <View style={styles.bottom}>
        {step === 'start' ? (
          <>
            <View style={styles.readyRow}>
              <Ionicons name="checkmark" size={18} color={colors.correct} />
              <Text style={styles.ready}>{strings.discoverEndReady}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              testID="discover-end-start"
              disabled={busy}
              onPress={onStart}
              style={[cardButton.solid, busy && cardButton.disabled]}
            >
              <Text style={cardButton.solidLabel}>{strings.discoverEndStart}</Text>
            </Pressable>
          </>
        ) : step === 'wait' || step === 'create' ? (
          <View testID="discover-end-preparing" style={styles.readyRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.muted}>{strings.discoverEndPreparing}</Text>
          </View>
        ) : (
          <>
            <Text testID="discover-end-none" style={styles.muted}>
              {step === 'empty' ? strings.discoverEndEmpty : strings.preparationFailed}
            </Text>
            <Pressable accessibilityRole="button" testID="discover-end-home" onPress={onHome} style={cardButton.pale}>
              <Text style={cardButton.paleLabel}>{strings.discoverEndHome}</Text>
            </Pressable>
          </>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, paddingBottom: spacing.md },
  hero: { alignItems: 'center', gap: 2, paddingVertical: spacing.sm },
  count: { fontSize: fontSizes.xxl, lineHeight: lineHeights.xxl, fontWeight: '800', color: colors.primary },
  label: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  group: { backgroundColor: colors.surface, borderRadius: radii.group, paddingHorizontal: spacing.md, ...shadows.card },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, paddingVertical: 11 },
  hairline: { borderBottomWidth: 1, borderBottomColor: colors.hairline },
  word: { flexShrink: 1, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700', color: colors.text },
  meaning: { flexShrink: 1, fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  failed: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  bottom: { gap: spacing.sm, paddingVertical: spacing.sm },
  readyRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 },
  ready: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, fontWeight: '700', color: colors.correct, writingDirection: 'rtl' },
  muted: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
});
