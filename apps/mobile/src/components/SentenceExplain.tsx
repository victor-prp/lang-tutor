import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { explainPanel, type ExplainLoad } from '@/explain';
import { useApi } from '@/hooks/useApi';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  sessionId: string;
  questionId: string;
};

/**
 * Phase 66 (spec D3). The הסבר button under a translation card's reference, and
 * the panel a tap opens. Mounted only when there is a sentence to explain, and it
 * asks at once, so the answer is usually there by the tap. Leaving the card drops
 * the result, which the server has stored anyway. Nothing here grades.
 */
export function SentenceExplain({ sessionId, questionId }: Props) {
  const api = useApi();
  const [load, setLoad] = useState<ExplainLoad>({ status: 'loading' });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // A result that lands after the card is gone sets nothing.
    let mounted = true;
    setLoad({ status: 'loading' });
    api.explainAnswer(sessionId, { question_id: questionId }).then(
      (explanation) => {
        if (mounted) setLoad({ status: 'ready', explanation });
      },
      () => {
        if (mounted) setLoad({ status: 'failed' });
      },
    );
    return () => {
      mounted = false;
    };
  }, [api, sessionId, questionId]);

  const panel = explainPanel(load);
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        hitSlop={8}
        testID="explain-button"
        onPress={() => setOpen((was) => !was)}
        style={[styles.button, open && styles.buttonOpen]}
      >
        <Text style={[styles.buttonText, open && styles.buttonTextOpen]}>{strings.explainButton}</Text>
      </Pressable>
      {open ? (
        <View style={styles.panel} testID="explain-panel">
          {panel.kind === 'line' ? (
            <Text style={styles.line}>{panel.text}</Text>
          ) : (
            <>
              <Text style={styles.label}>{strings.explainCorrected}</Text>
              <Text style={styles.corrected} testID="explain-corrected">
                {panel.corrected}
              </Text>
              {panel.mistakes.map((mistake, index) => (
                <View key={index} style={styles.mistake} testID="explain-mistake">
                  <Text style={styles.fix}>
                    {mistake.wrong === '' ? null : <Text style={styles.wrong}>{mistake.wrong}</Text>}
                    {mistake.wrong === '' ? null : '  →  '}
                    <Text style={styles.right}>{mistake.right}</Text>
                  </Text>
                  <Text style={styles.why}>{strings.explainWhy(mistake.why)}</Text>
                </View>
              ))}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', alignItems: 'center', gap: spacing.sm },
  button: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  buttonOpen: { backgroundColor: colors.primary },
  buttonText: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.primary, fontWeight: '600' },
  buttonTextOpen: { color: colors.onPrimary },
  panel: {
    alignSelf: 'stretch',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.primarySurface,
  },
  line: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, textAlign: 'center', writingDirection: 'rtl' },
  label: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  // The learner's languages: the sentence and the fixes in the target, left to right.
  corrected: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, fontWeight: '600', writingDirection: 'ltr', textAlign: 'center' },
  mistake: { gap: 2, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  fix: { fontSize: fontSizes.md, lineHeight: lineHeights.md, writingDirection: 'ltr', textAlign: 'center' },
  wrong: { color: colors.wrong, textDecorationLine: 'line-through' },
  right: { color: colors.correct, fontWeight: '600' },
  why: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
});
