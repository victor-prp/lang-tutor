import Ionicons from '@expo/vector-icons/Ionicons';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { strings } from '@/strings';
import { colors, radii, shadows, spacing } from '@/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Phase 64 (spec D1). Each tab's name, icon and testID. מילים keeps the testID of home's
 *  old vocabulary button, and אני the profile button's, so a test reaches the same place. */
const TABS: Record<string, { label: string; icon: IconName; testID: string }> = {
  // Phase 64b (spec D1): home, which may hold more than practice later.
  index: { label: strings.tabHome, icon: 'home-outline', testID: 'tab-home' },
  words: { label: strings.tabWords, icon: 'book-outline', testID: 'vocabulary-entry' },
  me: { label: strings.tabMe, icon: 'person-outline', testID: 'profile-button' },
  settings: { label: strings.tabSettings, icon: 'settings-outline', testID: 'settings-tab' },
};

/**
 * Phase 64 (spec D1). The bar along the bottom of the four tabs, right to left as Hebrew
 * reads: the active tab blue with a pale pill behind its icon, the others grey. It shows on
 * the tabs only; everything else opens over them (D10).
 */
export function TabBar({ state, navigation, insets }: BottomTabBarProps) {
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      {state.routes.map((route, at) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === at;
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            aria-selected={focused}
            testID={tab.testID}
            onPress={onPress}
            style={styles.tab}
          >
            <View style={[styles.pill, focused && styles.pillOn]}>
              <Ionicons name={tab.icon} size={21} color={focused ? colors.primary : colors.tabInactive} />
            </View>
            <Text style={[styles.label, focused && styles.labelOn]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: colors.surface, paddingTop: 7, ...shadows.bar },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  pill: { paddingVertical: 3, paddingHorizontal: 15, borderRadius: radii.pill },
  pillOn: { backgroundColor: colors.primarySurface },
  label: { fontSize: 11, lineHeight: 15, color: colors.tabInactive },
  labelOn: { color: colors.primary, fontWeight: '700' },
});
