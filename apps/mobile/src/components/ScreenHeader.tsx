import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

/**
 * Phase 64 (spec D11). The top row of a screen opened over the tabs: a back arrow at the
 * start (the right, pointing right as Hebrew reads back) and the title, or, for a full-screen
 * flow, the title with a ✕ at the end. `trailing` is anything else the row holds at its end.
 */
export function ScreenHeader({
  title,
  titleTestID,
  onBack,
  backTestID,
  close = false,
  trailing,
}: {
  title: string;
  titleTestID?: string;
  onBack: () => void;
  backTestID?: string;
  close?: boolean;
  trailing?: ReactNode;
}) {
  const back = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={close ? strings.cancel : strings.back}
      testID={backTestID}
      hitSlop={8}
      onPress={onBack}
      style={styles.back}
    >
      <Ionicons name={close ? 'close' : 'arrow-forward'} size={24} color={colors.text} />
    </Pressable>
  );
  return (
    <View style={styles.row}>
      {close ? null : back}
      <Text testID={titleTestID} style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {trailing}
      {close ? back : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 40 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: {
    flex: 1,
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '800',
    color: colors.text,
    writingDirection: 'rtl',
  },
});
