import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function LoginScreen() {
  const { user, rememberedUsername, login } = useCurrentUser();
  const [username, setUsername] = useState('');
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // rememberedUsername arrives after a storage read, so it cannot be the
  // initial state. Adopt it until the learner types — after that, their text wins.
  useEffect(() => {
    if (!edited) setUsername(rememberedUsername);
  }, [rememberedUsername, edited]);

  // Also covers landing here while already identified, e.g. via back navigation.
  if (user) return <Redirect href="/" />;

  async function onLogin() {
    setBusy(true);
    setError(null);
    try {
      await login(username.trim());
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 404
          ? strings.loginUnknownUser
          : strings.loginFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.loginTitle}</Text>

      <Text style={styles.label}>{strings.loginUsernameLabel}</Text>
      <TextInput
        testID="login-username"
        value={username}
        onChangeText={(text) => {
          setEdited(true);
          setUsername(text);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        // The app is force-RTL but a username is lowercase ASCII: without this
        // the text and the caret render on the wrong side.
        style={[styles.input, styles.ltr]}
      />
      <Text style={styles.hint}>{strings.usernameHint}</Text>

      {error ? (
        <Text testID="login-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="login-button"
        onPress={onLogin}
        disabled={busy || username.trim().length === 0}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.loginAction}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="new-user-button"
        onPress={() => router.push('/onboarding')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryLabel}>{strings.newUserAction}</Text>
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
