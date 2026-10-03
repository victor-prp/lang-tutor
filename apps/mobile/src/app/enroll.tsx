import type { LanguageCode } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { availableTargets } from '@/enrollments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Reached from sign-up, from any login that finds no enrollment, and from the
 * switcher's "add a language". One screen for all three, so a sign-up whose
 * second call never landed is simply a learner who has not enrolled yet.
 */
export default function EnrollScreen() {
  const { user, enrollments, enroll } = useCurrentUser();
  const targets = availableTargets(enrollments);
  const [picked, setPicked] = useState<LanguageCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return <Redirect href="/login" />;
  if (targets.length === 0) return <Redirect href="/" />;

  const selected = picked && targets.includes(picked) ? picked : targets[0];

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await enroll(selected);
      router.dismissTo('/');
    } catch {
      setError(strings.enrollFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.enrollTitle}</Text>
      <Text style={styles.hint}>{strings.enrollExplanation}</Text>

      <View style={styles.choiceRow}>
        {targets.map((code) => (
          <Pressable
            key={code}
            accessibilityRole="button"
            accessibilityState={{ selected: selected === code }}
            testID={`enroll-${code}`}
            onPress={() => setPicked(code)}
            style={[styles.choice, selected === code && styles.choiceSelected]}
          >
            <Text style={[styles.choiceLabel, selected === code && styles.choiceLabelSelected]}>
              {strings.languageName(code)}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <Text testID="enroll-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="enroll-submit"
        onPress={onSubmit}
        disabled={busy}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.enrollSubmit}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  hint: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
  choiceRow: { flexDirection: 'row', gap: spacing.sm },
  choice: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  choiceSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  choiceLabel: { fontSize: fontSizes.md, color: colors.text },
  choiceLabelSelected: { color: colors.onPrimary, fontWeight: '700' },
  error: { fontSize: fontSizes.md, color: colors.wrong, writingDirection: 'rtl' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
});
