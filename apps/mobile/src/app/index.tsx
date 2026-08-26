import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSession } from '@/hooks/useSession';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function HomeScreen() {
  const { start } = useSession();

  function onStart() {
    start();
    router.push('/session');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.appTitle}</Text>
      <Text style={styles.subtitle}>{strings.homeSubtitle}</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{strings.homeSetLabel(SESSION_LENGTH)}</Text>
      </View>

      <Pressable accessibilityRole="button" onPress={onStart} style={styles.button}>
        <Text style={styles.buttonLabel}>{strings.start}</Text>
      </Pressable>

      {/* Deliberately empty. Streak, points and daily-target widgets land here. */}
      <View style={styles.futureSpace} />
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
  subtitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
  card: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardLabel: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
    writingDirection: 'rtl',
  },
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
  futureSpace: { flex: 1 },
});
