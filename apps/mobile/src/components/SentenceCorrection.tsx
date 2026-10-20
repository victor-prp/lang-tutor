import type { ExplainResponse } from '@lang-tutor/core/api';
import { StyleSheet, Text, View } from 'react-native';

import { correctedRuns } from '@/explain';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  /** The learner's own sentence, as sent. */
  text: string;
  explanation: ExplainResponse;
  /** הסבר tapped on the banner: each mistake and why, under the corrected sentence. */
  open: boolean;
};

/**
 * Phase 66b (spec D2). Under a translation's input, when its sentence needs a
 * fix: the sentence corrected, the words that changed in green, with no reasons;
 * the reasons only once הסבר is tapped. Nothing here grades.
 */
export function SentenceCorrection({ text, explanation, open }: Props) {
  if (explanation.mistakes.length === 0) return null;
  return (
    <View style={styles.container}>
      <Text style={styles.corrected} testID="sentence-corrected">
        <Text style={styles.good}>{'✓ '}</Text>
        {correctedRuns(text, explanation.corrected).map((run, index) =>
          run.changed ? (
            <Text key={index} style={styles.good}>
              {run.text}
            </Text>
          ) : (
            run.text
          ),
        )}
      </Text>
      {open ? (
        <View style={styles.panel} testID="explain-panel">
          {explanation.mistakes.map((mistake, index) => (
            <View key={index} style={[styles.mistake, index > 0 && styles.divided]} testID="explain-mistake">
              <Text style={styles.fix}>
                {mistake.wrong === '' ? null : <Text style={styles.wrong}>{mistake.wrong}</Text>}
                {mistake.wrong === '' ? null : '  →  '}
                <Text style={styles.good}>{mistake.right}</Text>
              </Text>
              <Text style={styles.why}>{strings.explainWhy(mistake.why)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', gap: spacing.sm },
  // The learner's language is the target: the sentence and the fixes read left to right.
  corrected: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'ltr', paddingHorizontal: spacing.sm },
  good: { color: colors.correct, fontWeight: '700' },
  panel: { alignSelf: 'stretch', padding: spacing.md, borderRadius: radii.md, backgroundColor: colors.surface },
  mistake: { gap: 2 },
  divided: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  fix: { fontSize: fontSizes.md, lineHeight: lineHeights.md, writingDirection: 'ltr', textAlign: 'center' },
  wrong: { color: colors.wrong, textDecorationLine: 'line-through' },
  why: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
});
