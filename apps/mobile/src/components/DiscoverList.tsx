import type { DiscoveryRun, PhotoImportItem, PhotoImportItemUpdate } from '@lang-tutor/core/api';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { cardButton } from '@/components/BandCard';
import { PhotoImportRow } from '@/components/PhotoImportRow';
import { itemsWaiting, tickedCount, withItem } from '@/discovery';
import { useApi } from '@/hooks/useApi';
import { IMPORT_POLL_INTERVAL_MS } from '@/photoImports';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

/** A row with a change applied, as the server will have it. */
function changedRow(row: PhotoImportItem, update: PhotoImportItemUpdate): PhotoImportItem {
  return {
    ...row,
    ...(update.ticked !== undefined ? { ticked: update.ticked } : {}),
    ...(update.gloss_id !== undefined ? { chosen_gloss_id: update.gloss_id } : {}),
  };
}

/**
 * Phase 69 (spec D8). A run's list: the words the learner did not know, reviewed as a photo's
 * rows are (PhotoImportRow), polled while one is still looked up, each tick sent at once and
 * put back if refused. Continue saves the ticked ones; ביטול discards the run.
 */
export function DiscoverList({
  run,
  wordDirection,
  busy,
  onRun,
  onSave,
  onDiscard,
}: {
  run: DiscoveryRun;
  wordDirection: 'rtl' | 'ltr';
  /** A save or a discard in flight. */
  busy: boolean;
  onRun: (run: DiscoveryRun) => void;
  onSave: (count: number) => void;
  onDiscard: () => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState<number | null>(null);
  const [changing, setChanging] = useState<ReadonlySet<number>>(new Set());
  const [failed, setFailed] = useState(false);
  // The latest run and the rows whose change has not landed, for the poll and the change.
  const latest = useRef(run);
  latest.current = run;
  const inFlight = useRef(new Set<number>());

  const waiting = itemsWaiting(run);
  // Polled while a row is looked up, and only while the screen is focused. A row with a
  // change in flight keeps the change.
  useFocusEffect(
    useCallback(() => {
      if (!waiting) return undefined;
      const timer = setInterval(() => {
        void api
          .getDiscoveryRun(latest.current.id)
          .then((polled) => {
            const kept = latest.current.items.filter((row) => inFlight.current.has(row.position));
            onRun(kept.reduce(withItem, polled));
          })
          .catch(() => undefined);
      }, IMPORT_POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [waiting, api, onRun]),
  );

  const change = async (row: PhotoImportItem, update: PhotoImportItemUpdate) => {
    if (inFlight.current.has(row.position)) return;
    inFlight.current.add(row.position);
    setChanging(new Set(inFlight.current));
    setFailed(false);
    onRun(withItem(latest.current, changedRow(row, update)));
    try {
      const saved = await api.updateDiscoveryItem(run.id, row.position, update);
      onRun(withItem(latest.current, saved));
    } catch {
      onRun(withItem(latest.current, row));
      setFailed(true);
    } finally {
      inFlight.current.delete(row.position);
      setChanging(new Set(inFlight.current));
    }
  };

  const count = tickedCount(run);
  const blocked = busy || waiting || changing.size > 0;
  return (
    <View style={styles.screen}>
      <Text testID="discover-list-title" style={styles.title}>
        {strings.discoverListTitle}
      </Text>
      <Text style={styles.hint}>{run.items.length > 0 ? strings.discoverListHint : strings.discoverListEmpty}</Text>
      {waiting ? (
        <View testID="discover-looking-up" style={styles.status}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.statusText}>{strings.discoverLookingUp}</Text>
        </View>
      ) : null}
      {failed ? <Text style={styles.failed}>{strings.discoverFailed}</Text> : null}
      <FlatList
        data={run.items}
        keyExtractor={(row) => String(row.position)}
        contentContainerStyle={run.items.length > 0 ? styles.list : undefined}
        renderItem={({ item: row }) => (
          <PhotoImportRow
            item={row}
            wordDirection={wordDirection}
            locked={busy || changing.has(row.position)}
            expanded={open === row.position}
            onExpand={(expanded) => setOpen(expanded ? row.position : null)}
            onChange={(update) => void change(row, update)}
          />
        )}
      />
      <View style={styles.actions}>
        {run.items.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            testID="discover-save"
            disabled={blocked || count === 0}
            onPress={() => onSave(count)}
            style={[cardButton.solid, (blocked || count === 0) && cardButton.disabled]}
          >
            <Text style={cardButton.solidLabel}>{strings.discoverSave(count)}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          testID="discover-discard"
          disabled={busy}
          onPress={onDiscard}
          style={[cardButton.pale, busy && cardButton.disabled]}
        >
          <Text style={cardButton.paleLabel}>{strings.discoverDiscard}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: spacing.sm },
  title: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '800', color: colors.text, writingDirection: 'rtl' },
  hint: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  failed: { fontSize: fontSizes.sm, color: colors.wrong, writingDirection: 'rtl' },
  list: { backgroundColor: colors.surface, borderRadius: radii.group, overflow: 'hidden', ...shadows.card },
  actions: { gap: spacing.sm, paddingVertical: spacing.sm },
});
