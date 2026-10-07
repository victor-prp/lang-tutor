import { Redirect, router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LearningSection } from '@/components/LearningSection';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

export default function HomeScreen() {
  const { user, active } = useCurrentUser();

  if (!user) return <Redirect href="/login" />;
  // Zero enrollments is a valid state (spec §5): sign-up, a login that finds
  // none, or a sign-up whose second call never landed all arrive here.
  if (!active) return <Redirect href="/enroll" />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.appTitle}</Text>
      <Text style={styles.subtitle}>{strings.homeSubtitle}</Text>

      <Pressable
        accessibilityRole="button"
        testID="profile-button"
        onPress={() => router.push('/profile')}
        style={styles.profileLink}
      >
        <Text style={styles.profileLinkLabel}>{user.display_name}</Text>
      </Pressable>

      <LearningSection active={active} />

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
  profileLink: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  profileLinkLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  futureSpace: { flex: 1 },
});
