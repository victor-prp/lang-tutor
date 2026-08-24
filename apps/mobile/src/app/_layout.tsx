import { Stack } from 'expo-router';
import { I18nManager, Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from '@/theme';

// RTL is set two different ways because the platforms disagree about how.
//
// Native: I18nManager is the real mechanism, but it only applies a flip on
// reload, so the `direction` style below makes the very first render RTL too.
//
// Web: react-native-web stubs I18nManager out entirely — forceRTL is a no-op and
// isRTL is hardcoded false — and its StyleSheet validator deletes a `direction`
// property outright. Its actual mechanism is the `dir` prop, which sets the DOM
// attribute and installs the LocaleProvider that every descendant reads to
// resolve start/end and mirror flex rows. `dir` is not in React Native's own
// ViewProps, so it is cast in for the one platform that reads it.
I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

const rtlProps = { dir: 'rtl' } as unknown as ViewProps;

export default function RootLayout() {
  return (
    // Every screen uses SafeAreaView. The navigator happens to provide a
    // fallback provider, but relying on that is relying on an internal detail —
    // and on web the insets are zero without an explicit provider.
    <SafeAreaProvider>
      <View style={styles.root} {...rtlProps}>
        <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    // Native-only: a valid Yoga style there, deleted with an error on web.
    ...Platform.select({ web: null, default: { direction: 'rtl' as const } }),
  },
  content: { backgroundColor: colors.background },
});
