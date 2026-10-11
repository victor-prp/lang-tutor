import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AppUpdates } from '@/appUpdates';
import { storeLink } from '@/storeLink';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

// Phase 32 (spec D9); phase 36 (spec D9): TestFlight on iOS, Play otherwise.
const store = storeLink(Platform.OS);

/**
 * Shown in place of every screen once the server has answered 426. An
 * over-the-air update for this build may already fix it, so that is tried
 * first and reloads the app when it lands. Otherwise the fix is a newer build,
 * which only the store can install: Play, or TestFlight on iOS. "Check again" retries the first step: a release
 * that raises the API level answers 426 as soon as the server is live, minutes
 * before its over-the-air update is published.
 */
export function UpdateRequired({ updates }: { updates: AppUpdates }) {
  const [checking, setChecking] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void updates.tryOverTheAir().then((reloading) => {
      if (live && !reloading) setChecking(false);
    });
    return () => {
      live = false;
    };
  }, [updates, attempt]);

  function checkAgain() {
    setChecking(true);
    setAttempt((n) => n + 1);
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="update-required">
      {checking ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.body}>{strings.updateChecking}</Text>
        </View>
      ) : (
        <View style={styles.center}>
          <Text style={styles.title}>{strings.updateRequiredTitle}</Text>
          <Text style={styles.body}>{strings.updateRequiredBody}</Text>
          <Pressable
            accessibilityRole="button"
            testID="update-required-store"
            onPress={() => void Linking.openURL(store.url)}
            style={styles.button}
          >
            <Text style={styles.buttonLabel}>{store.label}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            testID="update-required-check-again"
            onPress={checkAgain}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>{strings.updateCheckAgain}</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  body: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, textAlign: 'center' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: { color: colors.onPrimary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
  secondary: { paddingVertical: spacing.sm, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
