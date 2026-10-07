import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LookupPanel } from '@/components/LookupPanel';
import { confirm } from '@/confirm';
import { studentGrant } from '@/grants';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { TranslationProvider } from '@/hooks/useTranslation';
import { strings } from '@/strings';
import { colors, fontSizes, spacing } from '@/theme';

/** Phase 28 (spec D10, D14). A tutor adds words to one student's list: the
 *  lookup panel in tutor mode, on the grant's enrollment. Only an ACCEPTED grant
 *  opens it. */
export default function StudentWordsScreen() {
  const api = useApi();
  const { grant: grantId } = useLocalSearchParams<{ grant: string }>();
  const { user, grants, endGrant } = useCurrentUser();
  if (!user) return <Redirect href="/login" />;
  const grant = grantId ? studentGrant(grants, grantId) : undefined;
  if (!grant) return <Redirect href="/" />;

  async function onStop() {
    if (!grant) return;
    const yes = await confirm({
      title: strings.stopTutoringTitle,
      message: strings.stopTutoringMessage(grant.owner.display_name),
      confirm: strings.stopTutoring(grant.owner.display_name),
      cancel: strings.cancel,
    });
    if (!yes) return;
    await endGrant(grant.id);
    router.back();
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="student-words-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text testID="student-words-title" style={styles.title}>
          {strings.studentWordsTitle(grant.owner.display_name, grant.enrollment.target_language)}
        </Text>
      </View>
      <TranslationProvider api={api} list={{ enrollment: grant.enrollment, mode: 'tutor' }}>
        <LookupPanel />
      </TranslationProvider>
      <Pressable accessibilityRole="button" testID="student-stop" onPress={onStop} style={styles.stop}>
        <Text style={styles.link}>{strings.stopTutoring(grant.owner.display_name)}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  stop: { paddingVertical: spacing.md, alignItems: 'center' },
});
