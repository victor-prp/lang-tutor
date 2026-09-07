import { Redirect } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

const LANGUAGES = ['he', 'en'] as const;
type LanguageCode = (typeof LANGUAGES)[number];

function LanguageChoice({
  prefix,
  value,
  onChange,
}: {
  prefix: 'native' | 'target';
  value: LanguageCode;
  onChange: (code: LanguageCode) => void;
}) {
  return (
    <View style={styles.choiceRow}>
      {LANGUAGES.map((code) => (
        <Pressable
          key={code}
          accessibilityRole="button"
          accessibilityState={{ selected: value === code }}
          testID={`${prefix}-${code}`}
          onPress={() => onChange(code)}
          style={[styles.choice, value === code && styles.choiceSelected]}
        >
          <Text style={[styles.choiceLabel, value === code && styles.choiceLabelSelected]}>
            {strings.languageName(code)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function OnboardingScreen() {
  const { user, register } = useCurrentUser();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [age, setAge] = useState('');
  const [nativeLanguage, setNativeLanguage] = useState<LanguageCode>('he');
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>('en');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // register() sets the user, and this is what turns that into navigation.
  if (user) return <Redirect href="/" />;

  async function onSubmit() {
    const parsedAge = Number.parseInt(age, 10);

    // Only what can be checked without duplicating a rule. The username pattern
    // is stated in the hint and enforced by the server — re-implementing it here
    // would be a third copy of a regex that already lives in packages/core and
    // in a database CHECK.
    if (!username.trim() || !displayName.trim() || !Number.isInteger(parsedAge)) {
      setError(strings.onboardingIncomplete);
      return;
    }
    if (nativeLanguage === targetLanguage) {
      setError(strings.onboardingSameLanguage);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await register({
        username: username.trim(),
        display_name: displayName.trim(),
        age: parsedAge,
        native_language: nativeLanguage,
        target_language: targetLanguage,
      });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setError(strings.onboardingUsernameTaken);
      } else if (failure instanceof ApiError && failure.status === 400) {
        setError(strings.onboardingRejected);
      } else {
        setError(strings.onboardingFailed);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.onboardingTitle}</Text>

      <Text style={styles.label}>{strings.loginUsernameLabel}</Text>
      <TextInput
        testID="onboarding-username"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, styles.ltr]}
      />
      <Text style={styles.hint}>{strings.usernameHint}</Text>

      <Text style={styles.label}>{strings.onboardingNameLabel}</Text>
      <TextInput
        testID="onboarding-display-name"
        value={displayName}
        onChangeText={setDisplayName}
        style={styles.input}
      />

      <Text style={styles.label}>{strings.onboardingAgeLabel}</Text>
      <TextInput
        testID="onboarding-age"
        value={age}
        onChangeText={setAge}
        keyboardType="number-pad"
        style={[styles.input, styles.ltr]}
      />

      <Text style={styles.label}>{strings.onboardingNativeLabel}</Text>
      <LanguageChoice prefix="native" value={nativeLanguage} onChange={setNativeLanguage} />

      <Text style={styles.label}>{strings.onboardingTargetLabel}</Text>
      <LanguageChoice prefix="target" value={targetLanguage} onChange={setTargetLanguage} />

      {error ? (
        <Text testID="onboarding-error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="onboarding-submit"
        onPress={onSubmit}
        disabled={busy}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.onboardingSubmit}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.xs },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  label: {
    marginTop: spacing.sm,
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
});
