import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { signInProblem } from '@/signIn';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function SignInScreen() {
  const { status, sendCode } = useCurrentUser();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Also covers landing here while already signed in, e.g. via back navigation.
  if (status === 'signed_in' || status === 'needs_profile') return <Redirect href="/" />;

  async function onSend() {
    const address = email.trim();
    setBusy(true);
    setError(null);
    try {
      await sendCode(address);
      router.push({ pathname: '/sign-in-code', params: { email: address } });
    } catch (failure) {
      setError(strings.signInProblem[signInProblem(failure)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.signInTitle}</Text>

      <Text style={styles.label}>{strings.signInEmailLabel}</Text>
      <TextInput
        testID="sign-in-email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        // The app is force-RTL but an address is Latin: without this the text
        // and the caret render on the wrong side.
        style={[styles.input, styles.ltr]}
      />
      <Text testID="sign-in-new-here" style={styles.hint}>
        {strings.signInNewHere}
      </Text>

      {error ? (
        <Text testID="sign-in-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="sign-in-send"
        onPress={onSend}
        disabled={busy || email.trim().length === 0}
        style={[styles.button, (busy || email.trim().length === 0) && styles.disabled]}
      >
        <Text style={styles.buttonLabel}>{strings.signInSend}</Text>
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
  spacer: { flex: 1 },
});
