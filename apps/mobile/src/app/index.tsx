import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { availableTargets } from '@/enrollments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSession } from '@/hooks/useSession';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function HomeScreen() {
  const { start } = useSession();
  const { user, enrollments, active, switchTo } = useCurrentUser();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  if (!user) return <Redirect href="/login" />;
  // Zero enrollments is a valid state (spec §5): sign-up, a login that finds
  // none, or a sign-up whose second call never landed all arrive here.
  if (!active) return <Redirect href="/enroll" />;

  const canAdd = availableTargets(enrollments).length > 0;

  function onStart() {
    start();
    router.push('/session');
  }

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

      <Pressable
        accessibilityRole="button"
        testID="enrollment-switcher"
        onPress={() => setSwitcherOpen((open) => !open)}
        style={styles.switcher}
      >
        <Text style={styles.switcherLabel}>
          {strings.learningLabel(strings.languageName(active.target_language))}
        </Text>
      </Pressable>

      {switcherOpen ? (
        <View style={styles.switcherList}>
          {enrollments.map((enrollment) => (
            <Pressable
              key={enrollment.id}
              accessibilityRole="button"
              accessibilityState={{ selected: enrollment.id === active.id }}
              testID={`enrollment-option-${enrollment.target_language}`}
              onPress={() => {
                switchTo(enrollment.id);
                setSwitcherOpen(false);
              }}
              style={[styles.switcherItem, enrollment.id === active.id && styles.switcherItemActive]}
            >
              <Text style={styles.switcherItemLabel}>
                {strings.languageName(enrollment.target_language)}
              </Text>
            </Pressable>
          ))}
          {canAdd ? (
            <Pressable
              accessibilityRole="button"
              testID="enrollment-add"
              onPress={() => {
                setSwitcherOpen(false);
                router.push('/enroll');
              }}
              style={styles.switcherItem}
            >
              <Text style={styles.switcherAddLabel}>{strings.addLanguage}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardLabel}>
          {strings.homeSetLabel(SESSION_LENGTH, strings.languageName(active.target_language))}
        </Text>
      </View>

      <Pressable accessibilityRole="button" testID="start-button" onPress={onStart} style={styles.button}>
        <Text style={styles.buttonLabel}>{strings.start}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="translate-entry"
        onPress={() => router.push('/translate')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.translateEntry}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="vocabulary-entry"
        onPress={() => router.push('/vocabulary')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.vocabularyEntry}</Text>
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
  secondaryButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    color: colors.primary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  profileLink: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  profileLinkLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  switcher: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  switcherLabel: { color: colors.text, fontSize: fontSizes.md, fontWeight: '700', writingDirection: 'rtl' },
  switcherList: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  switcherItem: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  switcherItemActive: { backgroundColor: colors.background },
  switcherItemLabel: { color: colors.text, fontSize: fontSizes.md, writingDirection: 'rtl' },
  switcherAddLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700', writingDirection: 'rtl' },
  futureSpace: { flex: 1 },
});
