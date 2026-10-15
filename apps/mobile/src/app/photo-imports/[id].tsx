import type { PhotoImport, PhotoImportItemUpdate } from '@lang-tutor/core/api';
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PhotoImportRow } from '@/components/PhotoImportRow';
import { confirm } from '@/confirm';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePhotoImports } from '@/hooks/usePhotoImports';
import {
  IMPORT_POLL_INTERVAL_MS,
  afterFailedChange,
  afterReadBack,
  canSave,
  mergePolled,
  savedWordCount,
  shouldPollImport,
  statusLabel,
  tickedCount,
  withChange,
  withRow,
} from '@/photoImports';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

// How one read of the import ended (ReadOutcome in @/photoImports), with what it
// read when it was shown.
type Read = { outcome: 'applied'; read: PhotoImport } | { outcome: 'superseded' | 'failed' };

// Phase 26 (spec D13). The review of one import: every row with a sense starts
// ticked, any can be unticked or switched to another of its senses, and the
// ticked ones are saved in one go.
export default function PhotoImportReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { fetchImport, updateItem, save, discard } = usePhotoImports();
  const { active } = useCurrentUser();
  const [imp, setImp] = useState<PhotoImport | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // The row whose options are showing.
  const [open, setOpen] = useState<number | null>(null);
  // A save or discard in flight. The ref guards re-entry (state is stale
  // between two taps in one frame); the state draws the disabled look.
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // The rows whose change has not landed. The ref guards re-entry; the state
  // draws them disabled, and holds Save back until all have landed, so a save
  // never races a change it would refuse or save without.
  const inFlight = useRef(new Set<number>());
  const [changing, setChanging] = useState<ReadonlySet<number>>(new Set());
  // Every row this screen has sent a change for. A poll answered after a change
  // landed may still have been read before it, so these rows keep their local
  // copy: once a row is ready, nothing but this screen changes it.
  const changed = useRef(new Set<number>());
  // Reads are numbered as they start. An answer is shown unless a newer one
  // already has been, so an older poll answering late never overwrites a newer
  // read, and a slow answer still lands while polls keep starting.
  const started = useRef(0);
  const applied = useRef(0);

  const load = useCallback(async (): Promise<Read> => {
    const mine = ++started.current;
    try {
      const polled = await fetchImport(id);
      if (mine < applied.current) return { outcome: 'superseded' };
      applied.current = mine;
      setImp((local) => (local ? mergePolled(polled, local, changed.current) : polled));
      setLoadFailed(false);
      return { outcome: 'applied', read: polled };
    } catch {
      if (mine < applied.current) return { outcome: 'superseded' };
      setLoadFailed(true);
      return { outcome: 'failed' };
    }
  }, [fetchImport, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // While reading or looking up, and only while this screen is focused.
  const polling = shouldPollImport(imp);
  useFocusEffect(
    useCallback(() => {
      if (!polling) return undefined;
      const timer = setInterval(() => void load(), IMPORT_POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [polling, load]),
  );

  if (!active) return <Redirect href="/" />;
  const wordDirection = strings.textDirection(active.target_language);

  const mark = (position: number, on: boolean) => {
    if (on) inFlight.current.add(position);
    else inFlight.current.delete(position);
    setChanging(new Set(inFlight.current));
  };

  // Shown at once, sent at once, and put back if the server refuses it, as the
  // save toggles do. One change per row at a time. A change with no answer may
  // have landed, so the row is read again instead, and stays held (Save with
  // it) until that read answers: the screen must show what Save would save.
  const change = async (position: number, update: PhotoImportItemUpdate) => {
    const original = imp?.items.find((row) => row.position === position);
    if (!original || inFlight.current.has(position)) return;
    changed.current.add(position);
    mark(position, true);
    setImp((current) => current && withChange(current, position, update));
    try {
      const row = await updateItem(id, position, update);
      setImp((current) => current && withRow(current, row));
    } catch (error) {
      if (afterFailedChange(error) === 'revert') {
        setImp((current) => current && withRow(current, original));
      } else {
        changed.current.delete(position);
        const { outcome } = await load();
        if (afterReadBack(outcome) === 'revert') setImp((current) => current && withRow(current, original));
      }
    } finally {
      mark(position, false);
    }
  };

  async function act(work: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  // Back to the home that is already under this screen, with the count.
  const leaveSaved = (count: number) =>
    router.dismissTo({ pathname: '/', params: { photoSaved: String(count) } });

  const onSave = () =>
    act(async () => {
      setSaveFailed(false);
      try {
        const { saved_gloss_ids } = await save(id);
        leaveSaved(saved_gloss_ids.length);
      } catch {
        // The save landed and only its answer was lost: the import read back
        // says saved, and this ends as a save does. Otherwise it was refused
        // (discarded elsewhere, or a row changed under it), or never arrived,
        // and the import as it now is shows under the error.
        const reread = await load();
        const saved = savedWordCount(reread.outcome === 'applied' ? reread.read : null);
        if (saved !== null) leaveSaved(saved);
        else setSaveFailed(true);
      }
    });

  const onDiscard = async () => {
    const sure = await confirm({
      title: strings.photoImportDiscardTitle,
      message: strings.photoImportDiscardMessage,
      confirm: strings.photoImportDiscardConfirm,
      cancel: strings.photoImportDiscardCancel,
    });
    if (!sure) return;
    await act(async () => {
      try {
        await discard(id);
        router.dismissTo('/');
      } catch {
        void load();
      }
    });
  };

  const status = imp ? statusLabel(imp) : null;
  const empty = imp?.status === 'ready' && imp.items.length === 0;
  // A saved or discarded import (an old link) offers neither.
  const closed = imp === null || imp.status === 'saved' || imp.status === 'discarded';
  const saveDisabled = imp === null || !canSave(imp) || busy || changing.size > 0;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="photo-import-review-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text style={styles.title}>{strings.photoImportTitle}</Text>
      </View>

      {status ? (
        <View style={styles.status}>
          {polling ? <ActivityIndicator /> : null}
          <Text testID="photo-import-status" style={styles.statusLabel}>
            {status}
          </Text>
        </View>
      ) : null}

      {!imp ? (
        loadFailed ? (
          <Text style={styles.notice}>{strings.vocabularyLoadFailed}</Text>
        ) : (
          <ActivityIndicator />
        )
      ) : (
        <FlatList
          data={imp.items}
          extraData={{ open, changing, busy }}
          keyExtractor={(item) => String(item.position)}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            empty ? (
              <View testID="photo-import-empty" style={styles.empty}>
                <Text style={styles.notice}>
                  {strings.photoImportNoWords(strings.languageName(active.target_language))}
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <PhotoImportRow
              item={item}
              wordDirection={wordDirection}
              locked={busy || changing.has(item.position)}
              expanded={open === item.position}
              onExpand={(expanded) => setOpen(expanded ? item.position : null)}
              onChange={(update) => void change(item.position, update)}
            />
          )}
        />
      )}

      {saveFailed ? (
        <Text testID="photo-import-save-error" style={styles.error}>
          {strings.photoImportSaveFailed}
        </Text>
      ) : null}
      {imp && !closed ? (
        <View style={styles.footer}>
          {imp.status !== 'failed' && !empty ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saveDisabled }}
              disabled={saveDisabled}
              testID="photo-import-save"
              onPress={() => void onSave()}
              style={[styles.button, saveDisabled && styles.buttonDisabled]}
            >
              <Text style={styles.buttonLabel}>{strings.photoImportSave(tickedCount(imp))}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            testID="photo-import-discard"
            onPress={() => void onDiscard()}
            style={[styles.secondaryButton, busy && styles.buttonDisabled]}
          >
            <Text style={styles.secondaryButtonLabel}>{strings.photoImportDiscard}</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusLabel: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  list: { gap: spacing.sm, paddingBottom: spacing.xl },
  empty: { gap: spacing.sm, alignItems: 'center', paddingTop: spacing.xl },
  notice: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
  error: { color: colors.wrong, fontSize: fontSizes.md, lineHeight: lineHeights.md, writingDirection: 'rtl' },
  footer: { gap: spacing.sm, paddingBottom: spacing.md },
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
});
