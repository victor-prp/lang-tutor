import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePhotoImports } from '@/hooks/usePhotoImports';
import { POLL_INTERVAL_MS } from '@/nextSession';
import { isWorking, statusLabel } from '@/photoImports';
import type { Photo } from '@/photos';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

// Phase 26 (spec D13). Take or choose a photo of a word list, with the imports
// still open below it.
export default function PhotoImportsScreen() {
  const { active } = useCurrentUser();
  const { imports, reload, pick, upload } = usePhotoImports();
  // An upload in flight: both buttons wait for it.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A photo whose upload failed, kept so a retry does not pick it again.
  const [kept, setKept] = useState<Photo | null>(null);

  useFocusEffect(useCallback(() => reload(), [reload]));

  // The statuses below move while an import is read or looked up, as home's
  // card does.
  const polling = imports.some((summary) => isWorking(summary.status));
  useFocusEffect(
    useCallback(() => {
      if (!polling) return undefined;
      const timer = setInterval(reload, POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [polling, reload]),
  );

  if (!active) return <Redirect href="/" />;

  async function send(photo: Photo) {
    setBusy(true);
    setError(null);
    try {
      const summary = await upload(photo);
      setKept(null);
      // Replaced, not pushed: back from the review is home, not this screen.
      router.replace(`/photo-imports/${summary.id}`);
    } catch {
      setKept(photo);
      setError(strings.photoImportUploadFailed);
      setBusy(false);
    }
  }

  async function choose(source: 'camera' | 'gallery') {
    setError(null);
    // Shrinking the photo can fail too, which to the learner is the same failure.
    const result = await pick(source).catch(() => null);
    if (result === null) setError(strings.photoImportUploadFailed);
    else if (result.kind === 'denied') setError(strings.photoImportDenied);
    else if (result.kind === 'photo') await send(result.photo);
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="photo-import-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text style={styles.title}>{strings.photoImportTitle}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        testID="photo-import-take"
        disabled={busy}
        onPress={() => void choose('camera')}
        style={[styles.button, busy && styles.buttonDisabled]}
      >
        <Text style={styles.buttonLabel}>{strings.photoImportTake}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        testID="photo-import-choose"
        disabled={busy}
        onPress={() => void choose('gallery')}
        style={[styles.secondaryButton, busy && styles.buttonDisabled]}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.photoImportChoose}</Text>
      </Pressable>

      {busy ? <ActivityIndicator testID="photo-import-busy" /> : null}
      {error ? (
        <Text testID="photo-import-error" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {kept && !busy ? (
        <Pressable
          accessibilityRole="button"
          testID="photo-import-retry"
          onPress={() => void send(kept)}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonLabel}>{strings.translateRetry}</Text>
        </Pressable>
      ) : null}

      {imports.length > 0 ? <Text style={styles.sectionTitle}>{strings.photoImportOpenTitle}</Text> : null}
      <FlatList
        data={imports}
        keyExtractor={(summary) => summary.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            testID="photo-import-open"
            onPress={() => router.push(`/photo-imports/${item.id}`)}
            style={styles.row}
          >
            <Text style={styles.rowStatus}>{statusLabel(item)}</Text>
            {item.status === 'ready' ? (
              <Text style={styles.meta}>{strings.photoImportWordCount(item.item_count)}</Text>
            ) : null}
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: { color: colors.onPrimary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
  buttonDisabled: { opacity: 0.6 },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    color: colors.primary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  error: { color: colors.wrong, fontSize: fontSizes.md, lineHeight: lineHeights.md, writingDirection: 'rtl' },
  sectionTitle: {
    marginTop: spacing.md,
    fontSize: fontSizes.md,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  list: { gap: spacing.sm, paddingBottom: spacing.xl },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowStatus: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  meta: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
});
