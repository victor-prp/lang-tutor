import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Group, groupStyles } from '@/components/Group';
import { useAppRelease } from '@/hooks/useAppUpdates';
import { mobileAppLine } from '@/release';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

/**
 * Phase 64 (spec D7). The הגדרות tab, how the app behaves: the practice reminders, About with
 * the release this phone runs (phase 32 D10, phase 49 D4). Sign-out is the account's, so it is אני's.
 */
export default function SettingsTab() {
  const { release } = useAppRelease();

  return (
    <SafeAreaView style={styles.screen} edges={[]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{strings.settingsTitle}</Text>

        <Group>
          <Pressable
            accessibilityRole="button"
            testID="profile-reminders"
            onPress={() => router.push('/reminders')}
            style={groupStyles.row}
          >
            <View style={styles.lead}>
              <Ionicons name="notifications-outline" size={19} color={colors.primary} />
              <Text style={groupStyles.label}>{strings.remindersEntry}</Text>
            </View>
            <Ionicons name="chevron-back" size={18} color={colors.tabInactive} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            testID="app-version"
            onPress={() => router.push('/about')}
            style={groupStyles.row}
          >
            <View style={styles.lead}>
              <Ionicons name="information-circle-outline" size={19} color={colors.primary} />
              <Text style={groupStyles.label}>{strings.aboutTitle}</Text>
            </View>
            {/* Review M6: `dev (e91c0aa, uncommitted changes)` is wider than a small phone's row. */}
            <Text style={styles.version} numberOfLines={1}>
              {mobileAppLine(release)}
            </Text>
          </Pressable>
        </Group>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.md },
  title: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '800', color: colors.text, writingDirection: 'rtl' },
  lead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  version: { flexShrink: 1, fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'ltr' },
});
