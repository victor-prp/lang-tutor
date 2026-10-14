import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApi } from '@/hooks/useApi';
import { useAppRelease } from '@/hooks/useAppUpdates';
import {
  canCopy,
  copyText,
  mobileAppLine,
  nativeLine,
  readServerRelease,
  releaseReport,
  serverLine,
  type ServerRelease,
} from '@/release';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

// Phase 49 (spec D4). The exact release of each part: this bundle, the server
// it calls and the native binary, and one tap that copies all three for a bug
// report. The labels stay English (spec R4): they are what gets pasted.
function Line({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text testID={testID} style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

export default function AboutScreen() {
  const api = useApi();
  const { release, copy } = useAppRelease();
  const [server, setServer] = useState<ServerRelease>({ state: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void readServerRelease(api.health).then((result) => {
      if (live) setServer(result);
    });
    return () => {
      live = false;
    };
  }, [api]);

  async function onCopy() {
    setCopied(await copyText(copy, releaseReport(release, server)));
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Text style={styles.title}>{strings.aboutTitle}</Text>

      <View style={styles.card}>
        <Line label="Mobile App" value={mobileAppLine(release)} testID="about-mobile-app" />
        <Line label="Server" value={serverLine(server)} testID="about-server" />
        <Line label="Native" value={nativeLine(release.native)} testID="about-native" />
      </View>

      <Pressable
        accessibilityRole="button"
        testID="about-copy"
        disabled={!canCopy(server)}
        onPress={onCopy}
        style={[styles.button, !canCopy(server) && styles.disabled]}
      >
        <Text style={styles.buttonLabel}>{copied ? strings.aboutCopied : strings.aboutCopy}</Text>
      </Pressable>

      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}>
        <Text style={styles.secondaryLabel}>{strings.back}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  // Left to right on a Hebrew screen: each line reads like the copied text.
  row: {
    flexDirection: 'row',
    direction: 'ltr',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  label: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'ltr' },
  value: { flexShrink: 1, fontSize: fontSizes.md, color: colors.text, fontWeight: '700', writingDirection: 'ltr' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  disabled: { opacity: 0.5 },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  secondary: { paddingVertical: spacing.sm, alignItems: 'center' },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
