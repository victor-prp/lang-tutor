import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { strings } from '@/strings';
import type { Fuse } from '@/targets';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

const GRADIENT = `linear-gradient(150deg, ${colors.primary} 0%, ${colors.bandEnd} 100%)`;
// The header's gradient over the solid blue (spec D9). The new architecture draws
// `experimental_backgroundImage`; the web reads the CSS property itself. No native module.
const gradient = Platform.select<ViewStyle>({
  web: { backgroundImage: GRADIENT } as ViewStyle,
  default: { experimental_backgroundImage: GRADIENT } as ViewStyle,
});

/**
 * Phase 64 (spec D4, countdown-options.html option 1). A home card: a blue header across
 * its top (the kind with its icon, the big line, a pale line under it, a target's fuse) and a
 * white body. Blue for every kind (R8). `info` is drawn under the header and, with `onOpen`,
 * pressable with it, as a target's card opens its screen; `footer` (the button) is not.
 */
export function BandCard({
  testID,
  openTestID,
  onOpen,
  icon,
  kind,
  big,
  bigTestID,
  unit,
  line,
  fuse,
  fuseTestID,
  strip,
  info,
  footer,
}: {
  testID: string;
  openTestID?: string;
  onOpen?: () => void;
  icon: IconName;
  kind: string;
  big: string;
  bigTestID?: string;
  unit: string | null;
  line: string | null;
  fuse?: Fuse | null;
  fuseTestID?: string;
  /** A line right under the header, edge to edge: the urgency strip (spec D5). */
  strip?: ReactNode;
  info?: ReactNode;
  footer?: ReactNode;
}) {
  const top = (
    <>
      <View style={[styles.band, gradient]}>
        <View style={styles.circle} />
        <View style={styles.kindRow}>
          <Ionicons name={icon} size={15} color={colors.bandSoft} />
          <Text style={styles.kind}>{kind}</Text>
        </View>
        <Text testID={bigTestID} style={styles.bigLine}>
          <Text style={styles.big}>{big}</Text>
          {unit ? <Text style={styles.unit}>{` ${unit}`}</Text> : null}
        </Text>
        {line ? <Text style={styles.line}>{line}</Text> : null}
        {fuse ? <FuseLine fuse={fuse} testID={fuseTestID} /> : null}
      </View>
      {strip}
      {info ? <View style={styles.info}>{info}</View> : null}
    </>
  );
  return (
    <View testID={testID} style={styles.card}>
      {onOpen ? (
        <Pressable accessibilityRole="button" testID={openTestID} onPress={onOpen}>
          {top}
        </Pressable>
      ) : (
        top
      )}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

/** Phase 64 (spec D5). The fuse: the time left as a line from the start (the right, in RTL),
 *  white; amber with a pulsing tip and its label in the last two days. */
function FuseLine({ fuse, testID }: { fuse: Fuse; testID?: string }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!fuse.hot) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 800, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [fuse.hot, pulse]);
  return (
    <View testID={testID} accessibilityLabel={fuse.hot ? 'hot' : 'calm'} style={styles.fuse}>
      <View style={styles.fuseTrack}>
        <View style={styles.fuseRest} />
        <View style={[styles.fuseFill, { flex: fuse.share }, fuse.hot && styles.fuseFillHot]} />
        <Animated.View style={[styles.fuseTip, fuse.hot && styles.fuseTipHot, fuse.hot && { opacity: pulse }]} />
        <View style={{ flex: 1 - fuse.share }} />
      </View>
      {fuse.label ? (
        <View style={styles.fuseLabels}>
          <Text style={styles.fuseLabel}>{strings.fuseLabel}</Text>
          <Text style={styles.fuseLabel}>{fuse.label}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Phase 64 (spec D4, D9). A card's button: solid blue when pressing it is the thing to do
 *  now, pale blue with blue text otherwise. */
export const cardButton = StyleSheet.create({
  solid: { backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  solidLabel: { color: colors.onPrimary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
  pale: { backgroundColor: colors.primarySurface, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  paleLabel: { color: colors.primary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
  disabled: { opacity: 0.6 },
});

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radii.card, overflow: 'hidden', ...shadows.card },
  band: {
    backgroundColor: colors.primary,
    paddingHorizontal: 15,
    paddingTop: 16,
    paddingBottom: 16,
    gap: 2,
    overflow: 'hidden',
  },
  circle: {
    position: 'absolute',
    left: -30,
    top: -30,
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  kindRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kind: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.bandSoft, writingDirection: 'rtl' },
  bigLine: { color: colors.onPrimary, writingDirection: 'rtl' },
  big: { fontSize: 56, lineHeight: 64, fontWeight: '900', color: colors.onPrimary },
  unit: { fontSize: 18, fontWeight: '500', color: colors.onPrimary },
  line: { fontSize: 13, lineHeight: 18, color: colors.bandSoft, writingDirection: 'rtl' },
  fuse: { marginTop: spacing.sm, gap: 4 },
  fuseTrack: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 10,
  },
  fuseRest: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
  },
  fuseFill: { height: 6, borderRadius: radii.pill, backgroundColor: 'rgba(255, 255, 255, 0.85)' },
  fuseFillHot: { backgroundColor: colors.amberBright },
  fuseTip: { width: 10, height: 10, borderRadius: 5, marginStart: -5, backgroundColor: colors.onPrimary },
  fuseTipHot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.amberGlow,
    boxShadow: '0 0 10px 4px rgba(253, 176, 34, 0.8)',
  },
  fuseLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  fuseLabel: { fontSize: 12, lineHeight: 16, fontWeight: '700', color: colors.amberGlow, writingDirection: 'rtl' },
  info: { paddingHorizontal: 15, paddingTop: spacing.md, gap: spacing.sm },
  footer: { paddingHorizontal: 15, paddingTop: spacing.md, paddingBottom: 15, gap: spacing.sm },
});
