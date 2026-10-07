import type { LanguageCode } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ENROLLABLE_TARGETS } from '@/enrollments';
import { inviteErrorMessage, normalizeUsername } from '@/grants';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/** A tutor invites a student, by username, to share a list in one language. */
export default function InviteStudentScreen() {
  const { user, invite } = useCurrentUser();
  const [username, setUsername] = useState('');
  const [selected, setSelected] = useState<LanguageCode>(ENROLLABLE_TARGETS[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return <Redirect href="/login" />;

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await invite(username, selected);
      // From /enroll the stack is [enroll, invite]: leave it whole, so home is the root.
      if (router.canDismiss()) router.dismissAll();
      router.replace('/');
    } catch (failure) {
      setError(inviteErrorMessage(failure, normalizeUsername(username), selected));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || username.trim() === '';

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.inviteStudent}</Text>

      <Text style={styles.label}>{strings.inviteUsernameLabel}</Text>
      <TextInput
        testID="invite-username"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, styles.ltr]}
      />

      <Text style={styles.label}>{strings.inviteLanguageLabel}</Text>
      <View style={styles.choiceRow}>
        {ENROLLABLE_TARGETS.map((code) => (
          <Pressable
            key={code}
            accessibilityRole="button"
            accessibilityState={{ selected: selected === code }}
            testID={`invite-language-${code}`}
            onPress={() => setSelected(code)}
            style={[styles.choice, selected === code && styles.choiceSelected]}
          >
            <Text style={[styles.choiceLabel, selected === code && styles.choiceLabelSelected]}>
              {strings.languageName(code)}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <Text testID="invite-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="invite-submit"
        onPress={onSubmit}
        disabled={disabled}
        style={[styles.button, disabled && styles.buttonDisabled]}
      >
        <Text style={styles.buttonLabel}>{strings.inviteSubmit}</Text>
      </Pressable>

      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}>
        <Text style={styles.secondaryLabel}>{strings.back}</Text>
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
  label: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: fontSizes.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  ltr: { writingDirection: 'ltr', textAlign: 'left' },
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
  buttonDisabled: { opacity: 0.6 },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  secondary: { paddingVertical: spacing.sm, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
