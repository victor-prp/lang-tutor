import { Redirect, router } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LookupPanel } from '@/components/LookupPanel';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useTranslation } from '@/hooks/useTranslation';
import { strings } from '@/strings';
import { spacing } from '@/theme';

/** Translate, opened from the header's magnifier (phase 64, spec D2): a full screen over the
 *  tabs, with a ✕ that returns to the tab it came from. */
export default function TranslateScreen() {
  const t = useTranslation();
  if (!t.direction) return <Redirect href="/" />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScreenHeader title={strings.translateTitle} onBack={() => router.back()} backTestID="translate-back" close />
      <LookupPanel />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
});
