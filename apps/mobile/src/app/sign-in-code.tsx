import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { isCode, RESEND_AFTER_MS, signInProblem } from '@/signIn';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function SignInCodeScreen() {
  const { sendCode, signIn } = useCurrentUser();
  const { email: emailParam } = useLocalSearchParams<{ email: string }>();
  const email = Array.isArray(emailParam) ? emailParam[0] : (emailParam ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The moment "send a new code" unlocks; the screen is opened right after a send.
  const [unlockAt, setUnlockAt] = useState(() => Date.now() + RESEND_AFTER_MS);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((unlockAt - now) / 1000));

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email, code);
      router.replace('/');
    } catch (failure) {
      const problem = signInProblem(failure);
      if (problem === 'new_code_needed') setCode('');
      setError(strings.signInProblem[problem]);
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setBusy(true);
    setError(null);
    try {
      await sendCode(email);
      setCode('');
      setNow(Date.now());
      setUnlockAt(Date.now() + RESEND_AFTER_MS);
    } catch (failure) {
      setError(strings.signInProblem[signInProblem(failure)]);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = isCode(code) && !busy;
  const canResend = secondsLeft === 0 && !busy;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.signInCodeTitle}</Text>
      <Text testID="sign-in-sent-to" style={styles.hint}>
        {strings.signInSentTo(email)}
      </Text>

      <Text style={styles.label}>{strings.signInCodeLabel}</Text>
      <TextInput
        testID="sign-in-code"
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        maxLength={9}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        autoCorrect={false}
        style={[styles.input, styles.ltr]}
      />

      {error ? (
        <Text testID="sign-in-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="sign-in-submit"
        onPress={onSubmit}
        disabled={!canSubmit}
        style={[styles.button, !canSubmit && styles.disabled]}
      >
        <Text style={styles.buttonLabel}>{strings.signInSubmit}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="sign-in-resend"
        onPress={onResend}
        disabled={!canResend}
        style={[styles.secondaryButton, !canResend && styles.disabled]}
      >
        <Text style={styles.secondaryLabel}>
          {secondsLeft > 0 ? strings.signInResendIn(secondsLeft) : strings.signInResend}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="sign-in-other-email"
        onPress={() => router.back()}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryLabel}>{strings.signInOtherEmail}</Text>
      </Pressable>

      <View style={styles.spacer} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.sm },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  label: {
    marginTop: spacing.md,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    writingDirection: 'rtl',
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSizes.md,
    color: colors.text,
  },
  ltr: { writingDirection: 'ltr', textAlign: 'left' },
  hint: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  error: { fontSize: fontSizes.md, color: colors.wrong, writingDirection: 'rtl' },
  button: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  disabled: { opacity: 0.5 },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  secondaryButton: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  spacer: { flex: 1 },
});
