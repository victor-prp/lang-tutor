import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AppUpdates } from '@/appUpdates';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

// Phase 32 (spec D9). The app's package on Play, where the newer build is.
const STORE_URL = 'market://details?id=ai.wordspal.app';

/**
 * Shown in place of every screen once the server has answered 426. An
 * over-the-air update for this build may already fix it, so that is tried
 * first and reloads the app when it lands. Otherwise the fix is a newer build,
 * which only Play can install.
 */
export function UpdateRequired({ updates }: { updates: AppUpdates }) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let live = true;
    void updates.tryOverTheAir().then((reloading) => {
      if (live && !reloading) setChecking(false);
    });
    return () => {
      live = false;
    };
  }, [updates]);

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
            onPress={() => void Linking.openURL(STORE_URL)}
            style={styles.button}
          >
            <Text style={styles.buttonLabel}>{strings.updateRequiredButton}</Text>
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
});
