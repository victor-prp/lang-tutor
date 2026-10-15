import type { PhotoImportItem, PhotoImportItemUpdate } from '@lang-tutor/core/api';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { PhotoImportRow } from '@/components/PhotoImportRow';
import { usePhotoImports } from '@/hooks/usePhotoImports';
import { importsReviewOf, withImportChanged, type ReadImports } from '@/importsReview';
import {
  IMPORT_POLL_INTERVAL_MS,
  afterFailedChange,
  afterReadBack,
  mergePolled,
  withChange,
  withRow,
  type ReadOutcome,
} from '@/photoImports';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

const NONE: ReadonlySet<number> = new Set();
const keyOf = (importId: string, position: number) => `${importId}:${position}`;

/**
 * Phase 53 (spec D10, ruling R-D9). The target wizard's review of its photos, one import
 * each: the rows of all of them as one list (importsReviewOf), each ticked or switched to
 * another sense as the review of one import does it, the change sent to the row's own
 * import. Every import is read, then the ones still reading or looking up are polled.
 *
 * It tells the wizard whether Next may go on: every import settled and no change of a row
 * still in flight, so Done never sends a list a change is still on its way to.
 */
export function ImportsReview({
  importIds,
  wordDirection,
  locked,
  onSettled,
}: {
  /** The wizard's imports, in photo order. The wizard remounts the review when they change. */
  importIds: readonly string[];
  /** The direction of the language being learned, which the words are in. */
  wordDirection: 'rtl' | 'ltr';
  /** Done in flight: no row may change under it. */
  locked: boolean;
  onSettled: (settled: boolean) => void;
}) {
  const { fetchImport, updateItem } = usePhotoImports();
  const [imports, setImports] = useState<ReadImports>({});
  const [loadFailed, setLoadFailed] = useState(false);
  // The row whose senses are showing.
  const [open, setOpen] = useState<string | null>(null);
  // As the review of one import has them: the rows whose change has not landed (the ref
  // guards re-entry, the state draws them disabled and holds Next back), and every row
  // this review has sent a change for, which a poll then leaves as this review has it.
  const inFlight = useRef(new Set<string>());
  const [changing, setChanging] = useState<ReadonlySet<string>>(new Set());
  const changed = useRef(new Map<string, Set<number>>());
  // Reads are numbered per import as they start. An answer is shown unless a newer
  // read of that import already has been, so a late poll never overwrites a newer read.
  const started = useRef(new Map<string, number>());
  const applied = useRef(new Map<string, number>());

  const load = useCallback(
    async (importId: string): Promise<ReadOutcome> => {
      const mine = (started.current.get(importId) ?? 0) + 1;
      started.current.set(importId, mine);
      try {
        const polled = await fetchImport(importId);
        if (mine < (applied.current.get(importId) ?? 0)) return 'superseded';
        applied.current.set(importId, mine);
        setImports((current) => {
          const local = current[importId];
          const kept = changed.current.get(importId) ?? NONE;
          return { ...current, [importId]: local ? mergePolled(polled, local, kept) : polled };
        });
        setLoadFailed(false);
        return 'applied';
      } catch {
        if (mine < (applied.current.get(importId) ?? 0)) return 'superseded';
        setLoadFailed(true);
        return 'failed';
      }
    },
    [fetchImport],
  );

  const review = importsReviewOf(importIds, imports);

  // Every import when the step opens.
  useFocusEffect(
    useCallback(() => {
      for (const importId of importIds) void load(importId);
    }, [importIds, load]),
  );
  // Then the ones still waiting, until none is, and only while the wizard is focused.
  // The poll reads the waiting ones when it fires, not when it was set up.
  const waiting = useRef<readonly string[]>([]);
  useEffect(() => {
    waiting.current = review.waiting;
  });
  const polling = !review.settled;
  useFocusEffect(
    useCallback(() => {
      if (!polling) return undefined;
      const timer = setInterval(() => {
        for (const importId of waiting.current) void load(importId);
      }, IMPORT_POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [polling, load]),
  );

  const ready = review.settled && changing.size === 0;
  useEffect(() => {
    onSettled(ready);
  }, [ready, onSettled]);
  // Gone from the screen is not settled: coming back to the review waits for it again.
  useEffect(() => () => onSettled(false), [onSettled]);

  const mark = (key: string, on: boolean) => {
    if (on) inFlight.current.add(key);
    else inFlight.current.delete(key);
    setChanging(new Set(inFlight.current));
  };
  const changedIn = (importId: string): Set<number> => {
    const positions = changed.current.get(importId) ?? new Set<number>();
    changed.current.set(importId, positions);
    return positions;
  };

  // As the review of one import changes a row: shown at once, sent at once, put back if
  // the server refuses it, and read again if no answer came, held until that read answers.
  const change = async (importId: string, position: number, update: PhotoImportItemUpdate) => {
    const key = keyOf(importId, position);
    const original = imports[importId]?.items.find((row) => row.position === position);
    if (!original || inFlight.current.has(key)) return;
    const put = (row: PhotoImportItem) =>
      setImports((current) => withImportChanged(current, importId, (imp) => withRow(imp, row)));
    changedIn(importId).add(position);
    mark(key, true);
    setImports((current) => withImportChanged(current, importId, (imp) => withChange(imp, position, update)));
    try {
      put(await updateItem(importId, position, update));
    } catch (error) {
      if (afterFailedChange(error) === 'revert') {
        put(original);
      } else {
        changedIn(importId).delete(position);
        if (afterReadBack(await load(importId)) === 'revert') put(original);
      }
    } finally {
      mark(key, false);
    }
  };

  return (
    <View style={styles.review}>
      {review.status ? (
        <View style={styles.status}>
          <ActivityIndicator />
          <Text testID="wizard-review-status" style={styles.statusLabel}>
            {review.status}
          </Text>
        </View>
      ) : null}
      {/* Only while waiting: the poll is the retry. */}
      {loadFailed && !review.settled ? (
        <Text testID="wizard-review-load-failed" style={styles.note}>
          {strings.targetReviewLoadFailed}
        </Text>
      ) : null}
      {review.unread > 0 ? (
        <Text testID="wizard-review-unread" style={styles.note}>
          {strings.targetPhotosUnread(review.unread, importIds.length)}
        </Text>
      ) : null}
      <FlatList
        data={review.rows}
        extraData={{ open, changing, locked }}
        keyExtractor={(row) => keyOf(row.importId, row.item.position)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          review.empty ? (
            <Text testID="wizard-review-empty" style={styles.notice}>
              {strings.targetReviewEmpty}
            </Text>
          ) : null
        }
        renderItem={({ item: row }) => {
          const key = keyOf(row.importId, row.item.position);
          return (
            <PhotoImportRow
              item={row.item}
              wordDirection={wordDirection}
              locked={locked || changing.has(key)}
              expanded={open === key}
              onExpand={(expanded) => setOpen(expanded ? key : null)}
              onChange={(update) => void change(row.importId, row.item.position, update)}
            />
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  review: { flex: 1, gap: spacing.sm },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusLabel: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  note: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  list: { gap: spacing.sm, paddingBottom: spacing.xl },
  notice: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
    textAlign: 'center',
    paddingTop: spacing.xl,
  },
});
