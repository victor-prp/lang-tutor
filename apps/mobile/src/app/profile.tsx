import { Redirect, router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

function Row({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text testID={testID} style={styles.rowValue}>
        {value}
      </Text>
    </View>
  );
}

export default function ProfileScreen() {
  const { user, signOut } = useCurrentUser();

  if (!user) return <Redirect href="/login" />;

  function onSwitchUser() {
    signOut();
    router.replace('/login');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.profileTitle}</Text>

      <View style={styles.card}>
        <Row label={strings.loginUsernameLabel} value={user.username} testID="profile-username" />
        <Row label={strings.profileNameLabel} value={user.display_name} testID="profile-name" />
        <Row label={strings.profileAgeLabel} value={String(user.age)} testID="profile-age" />
        <Row
          label={strings.onboardingNativeLabel}
          value={strings.languageName(user.native_language)}
          testID="profile-native"
        />
        <Row
          label={strings.onboardingTargetLabel}
          value={strings.languageName(user.target_language)}
          testID="profile-target"
        />
      </View>

      <Pressable
        accessibilityRole="button"
        testID="switch-user-button"
        onPress={onSwitchUser}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{strings.switchUser}</Text>
      </Pressable>

      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}>
        <Text style={styles.secondaryLabel}>{strings.back}</Text>
      </Pressable>

      <View style={styles.spacer} />
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
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  rowLabel: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
  rowValue: { fontSize: fontSizes.md, color: colors.text, fontWeight: '700' },
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
  secondary: { paddingVertical: spacing.sm, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  spacer: { flex: 1 },
});
