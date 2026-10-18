import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

/**
 * Phase 64 (spec D7, D9). A grouped list: an optional small grey title above a white block
 * whose rows are parted by hairlines, as אני and הגדרות draw their settings.
 */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(children).filter((child) => isValidElement(child));
  return (
    <View style={groupStyles.wrap}>
      {title ? <Text style={groupStyles.title}>{title}</Text> : null}
      <View style={groupStyles.block}>
        {rows.map((row, at) => (
          <Fragment key={at}>
            {at > 0 ? <View style={groupStyles.hairline} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

/** A row of a group: a label, and its value at the row's end. */
export function GroupRow({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View style={groupStyles.row}>
      <Text style={groupStyles.label}>{label}</Text>
      <Text testID={testID} style={groupStyles.value}>
        {value}
      </Text>
    </View>
  );
}

export const groupStyles = StyleSheet.create({
  wrap: { gap: 6 },
  title: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: colors.muted, marginHorizontal: spacing.xs, writingDirection: 'rtl' },
  block: { backgroundColor: colors.surface, borderRadius: radii.group, overflow: 'hidden', ...shadows.card },
  hairline: { height: 1, backgroundColor: colors.hairline, marginHorizontal: spacing.md },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.md,
  },
  label: { flexShrink: 1, fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  value: { flexShrink: 1, fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, fontWeight: '600' },
  link: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.primary, fontWeight: '700', writingDirection: 'rtl' },
  danger: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.danger, fontWeight: '700', writingDirection: 'rtl' },
});
