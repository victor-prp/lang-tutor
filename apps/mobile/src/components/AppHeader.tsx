import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState, type ComponentProps } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { LanguageChip, LanguageList } from '@/components/LanguageSwitcher';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, spacing } from '@/theme';

/**
 * Phase 64 (spec D2, R2). The header on every tab: the language on the right (today's
 * switcher), and on the left two plain icons for the two most common actions, translate and
 * a photo of a word list. With no enrollment there is nothing to translate into or add to,
 * so the row is empty.
 */
export function AppHeader() {
  const { active } = useCurrentUser();
  const [open, setOpen] = useState(false);
  if (!active) return <View style={styles.row} />;
  return (
    <View style={styles.header}>
      <View style={styles.row}>
        <LanguageChip active={active} open={open} onToggle={() => setOpen((was) => !was)} />
        <View style={styles.icons}>
          <HeaderIcon
            name="search-outline"
            label={strings.translateEntry}
            testID="translate-entry"
            onPress={() => router.push('/translate')}
          />
          <HeaderIcon
            name="camera-outline"
            label={strings.photoImportEntry}
            testID="photo-entry"
            onPress={() => router.push('/targets/new')}
          />
        </View>
      </View>
      {open ? <LanguageList active={active} onDone={() => setOpen(false)} /> : null}
    </View>
  );
}

function HeaderIcon({
  name,
  label,
  testID,
  onPress,
}: {
  name: ComponentProps<typeof Ionicons>['name'];
  label: string;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={6}
      onPress={onPress}
      style={styles.icon}
    >
      <Ionicons name={name} size={23} color={colors.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 36 },
  icons: { flexDirection: 'row', gap: spacing.xs },
  icon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
});
