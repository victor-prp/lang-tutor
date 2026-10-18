import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/AppHeader';
import { TabBar } from '@/components/TabBar';
import { needsEnrollScreen } from '@/grants';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useReminders } from '@/hooks/useReminders';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Phase 64 (spec D1, D10). The four tabs and their bar. Everything else (a session,
 * translate, the photo flow, the screens a tab opens) is a screen of the root Stack, over
 * the tabs, where the bar does not show.
 *
 * Home's gates are here so they hold for every tab: loading, offline, signed out, a profile
 * to make, and the enroll screen. So are its two once-per-learner effects.
 */
export default function TabsLayout() {
  const { status, user, enrollments, active, grants, retry } = useCurrentUser();
  const reminders = useReminders();
  const shown = status === 'signed_in' && user !== null && !needsEnrollScreen(enrollments, grants);

  // Phase 52 (spec D1, D4). Once per learner while the tabs are shown: report the
  // zone their day follows, when it differs from the one the server holds (the
  // profile carries it), and, if they have a course of their own, ask to send
  // reminders (or register again, once granted). A tutor with no enrollment has
  // nothing to practise, and the server leaves them out of the tick as well; they
  // are asked when an enrollment arrives. Neither call throws, and nothing here
  // waits on them. Both are reset while the tabs are not shown, so a sign-out and a
  // sign-in report and register again (both are idempotent).
  const reportedFor = useRef<string | null>(null);
  const promptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!shown) {
      reportedFor.current = null;
      promptedFor.current = null;
      return;
    }
    if (reportedFor.current !== user.id) {
      reportedFor.current = user.id;
      void reminders.reportTimeZone(user.time_zone);
    }
    if (active && promptedFor.current !== user.id) {
      promptedFor.current = user.id;
      void reminders.promptOnce();
    }
  }, [shown, user, active, reminders]);

  if (status === 'loading')
    return (
      <SafeAreaView style={styles.loading} edges={['top', 'bottom']}>
        <ActivityIndicator testID="start-loading" size="large" color={colors.primary} />
      </SafeAreaView>
    );
  if (status === 'offline')
    return (
      <SafeAreaView style={styles.offline} edges={['top', 'bottom']}>
        <Text style={styles.title}>{strings.offlineTitle}</Text>
        <Pressable testID="offline-retry" accessibilityRole="button" onPress={() => void retry()} style={styles.button}>
          <Text style={styles.buttonLabel}>{strings.offlineRetry}</Text>
        </Pressable>
      </SafeAreaView>
    );
  if (status === 'signed_out') return <Redirect href="/sign-in" />;
  if (status === 'needs_profile' || !user) return <Redirect href="/onboarding" />;
  // No enrollment and no student is a valid state (spec §5): a new profile, or
  // a profile whose enrollment never landed, arrives here.
  // A tutor with students has a home of their own.
  if (needsEnrollScreen(enrollments, grants)) return <Redirect href="/enroll" />;

  // Phase 64 (spec D2). One header over the four tabs, not one per tab: a tab stays mounted
  // once visited, and four copies of its controls would be four of each testID.
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <AppHeader />
      </View>
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="words" />
        <Tabs.Screen name="me" />
        <Tabs.Screen name="settings" />
      </Tabs>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  offline: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
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
});
