import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { cardButton } from '@/components/BandCard';
import { InvitesSection } from '@/components/InvitesSection';
import { LearningSection } from '@/components/LearningSection';
import { StudentsSection } from '@/components/StudentsSection';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { spacing } from '@/theme';

/**
 * Phase 64 (spec D3), phase 64b (spec D1). The בית tab: the header, a tutor's invitation while it waits for an
 * answer, then the paths one card at a time. No title: the cards tell the story (R3). The
 * gates (signed out, a profile to make, the enroll screen) are the tab layout's.
 */
export default function HomeTab() {
  const { active, reloadGrants } = useCurrentUser();

  // Phase 52 (spec D8). A tapped reminder opens home with start=reminder, which
  // LearningSection acts on. A learner with no enrollment has nothing to start,
  // and the param must not wait there to start a session once they enroll.
  const { start } = useLocalSearchParams<{ start?: string }>();
  const navigation = useNavigation<{ setParams: (params: { start?: string }) => void }>();
  useEffect(() => {
    if (!active && start === 'reminder') navigation.setParams({ start: undefined });
  }, [active, start, navigation]);

  // Fresh on every focus: an invitation may have arrived, or been answered.
  useFocusEffect(
    useCallback(() => {
      void reloadGrants();
    }, [reloadGrants]),
  );

  return (
    <SafeAreaView style={styles.screen} edges={[]}>
      <ScrollView contentContainerStyle={styles.content}>
        <InvitesSection />
        {active ? (
          <LearningSection active={active} />
        ) : (
          <>
            {/* A tutor with no course of their own: home is their students (spec §5). */}
            <StudentsSection />
            <StartLearning />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StartLearning() {
  return (
    <Pressable
      accessibilityRole="button"
      testID="start-learning"
      onPress={() => router.push('/enroll')}
      style={cardButton.solid}
    >
      <Text style={cardButton.solidLabel}>{strings.startLearning}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
});
