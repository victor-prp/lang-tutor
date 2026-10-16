import type { QuestionTypesResponse } from '@lang-tutor/core/api';
import type { QuestionType } from '@lang-tutor/core/domain';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { useSession } from '@/hooks/useSession';
import { afterPreparing, initialSelection, toggled } from '@/questionTypes';
import { strings } from '@/strings';
import { colors, fontSizes, radii, spacing } from '@/theme';

/** How often the screen reads a preparing session. */
const POLL_MS = 1_000;

type Read = { devices: { listening: boolean; speaking: boolean }; senseId: string; types: QuestionTypesResponse['types'] };
/** Where the screen is: choosing, waiting for the session, or showing what it could not make. */
type Stage = { kind: 'choose' } | { kind: 'preparing' } | { kind: 'skipped'; sessionId: string; skipped: QuestionType[] } | { kind: 'failed'; skipped: QuestionType[] };

/**
 * Phase 61 (spec D6). A tester's session of one saved meaning: every question type,
 * the ones the word can have ticked, the others greyed with why; start builds the
 * session, waits for it, and enters it as home does.
 */
export default function QuestionTypesScreen() {
  const { glossId, variantId, translation } = useLocalSearchParams<{ glossId: string; variantId: string; translation?: string }>();
  const api = useApi();
  const { active } = useCurrentUser();
  const next = useNextSession();
  const { enter } = useSession();
  const [read, setRead] = useState<Read | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [chosen, setChosen] = useState<Set<QuestionType>>(new Set());
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [notice, setNotice] = useState<string | null>(null);
  // False once the screen unmounts: a poll or a read that lands after that writes nothing.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    let live = true;
    void (async () => {
      try {
        const devices = await next.devices(active.target_language);
        const answer = await api.questionTypes(active.id, { glossId, variantId, ...devices });
        if (!live) return;
        setRead({ devices, senseId: answer.sense_id, types: answer.types });
        setChosen(initialSelection(answer.types));
      } catch {
        if (live) setLoadFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, active, glossId, variantId, next.devices]);

  function enterSession(sessionId: string) {
    void next.start(sessionId);
    enter(sessionId);
    router.push('/session');
  }

  async function waitFor(sessionId: string) {
    while (alive.current) {
      const view = await api.getSession(sessionId);
      const outcome = afterPreparing(view);
      if (outcome.next === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      if (!alive.current) return;
      if (outcome.next === 'enter') enterSession(sessionId);
      else if (outcome.next === 'show_skipped') setStage({ kind: 'skipped', sessionId, skipped: outcome.skipped });
      else setStage({ kind: 'failed', skipped: outcome.skipped });
      return;
    }
  }

  async function start() {
    if (!active || !read || stage.kind !== 'choose') return;
    if (chosen.size === 0) {
      setNotice(strings.questionTypesNoneChosen);
      return;
    }
    setNotice(null);
    setStage({ kind: 'preparing' });
    try {
      const created = await api.createQuestionTypeSession(active.id, {
        gloss_id: glossId,
        variant_id: variantId,
        sense_id: read.senseId,
        // In the read's order, which is the session's.
        types: read.types.map((entry) => entry.type).filter((type) => chosen.has(type)),
        ...read.devices,
      });
      next.reload();
      await waitFor(created.session_id);
    } catch (error) {
      if (!alive.current) return;
      setStage({ kind: 'choose' });
      setNotice(
        error instanceof ApiError && error.code === 'session_open'
          ? strings.questionTypesSessionOpen
          : error instanceof ApiError && error.code === 'seed_pending'
            ? strings.questionTypesSeedPending
            : strings.questionTypesStartFailed,
      );
    }
  }

  const skippedList = (skipped: QuestionType[]) => (
    <View testID="skipped-types" style={styles.skipped}>
      <Text style={styles.notice}>{strings.questionTypesSkipped}</Text>
      {skipped.map((type) => (
        <Text key={type} style={styles.meta}>
          {strings.questionTypeName(type)}
        </Text>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Pressable accessibilityRole="button" testID="question-types-back" onPress={() => router.back()}>
        <Text style={styles.link}>{strings.back}</Text>
      </Pressable>
      <Text style={styles.title}>{translation ? `${strings.questionTypesTitle}: ${translation}` : strings.questionTypesTitle}</Text>
      {loadFailed ? <Text style={styles.notice}>{strings.questionTypesLoadFailed}</Text> : null}
      {notice ? (
        <Text testID="question-types-notice" style={styles.notice}>
          {notice}
        </Text>
      ) : null}

      {stage.kind === 'skipped' ? (
        <View style={styles.list}>
          {skippedList(stage.skipped)}
          <Pressable accessibilityRole="button" testID="question-types-continue" style={styles.button} onPress={() => enterSession(stage.sessionId)}>
            <Text style={styles.buttonLabel}>{strings.questionTypesContinue}</Text>
          </Pressable>
        </View>
      ) : stage.kind === 'failed' ? (
        <View style={styles.list}>
          <Text testID="question-types-failed" style={styles.notice}>
            {strings.questionTypesFailed}
          </Text>
          {stage.skipped.length > 0 ? skippedList(stage.skipped) : null}
        </View>
      ) : !read ? (
        loadFailed ? null : <ActivityIndicator />
      ) : (
        <>
          <ScrollView contentContainerStyle={styles.list}>
            {read.types.map((entry) => {
              const ticked = chosen.has(entry.type);
              return (
                <Pressable
                  key={entry.type}
                  role="checkbox"
                  aria-checked={ticked}
                  aria-disabled={!entry.available || stage.kind !== 'choose'}
                  disabled={!entry.available || stage.kind !== 'choose'}
                  testID={`question-type-${entry.type}`}
                  onPress={() => setChosen((current) => toggled(current, entry.type))}
                  style={[styles.row, !entry.available && styles.rowOff]}
                >
                  <Text style={styles.box}>{entry.available ? (ticked ? '☑' : '☐') : '–'}</Text>
                  <View style={styles.grow}>
                    <Text style={[styles.name, !entry.available && styles.nameOff]}>{strings.questionTypeName(entry.type)}</Text>
                    {entry.reason ? <Text style={styles.meta}>{strings.questionTypeUnavailable(entry.reason)}</Text> : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: stage.kind !== 'choose' }}
            disabled={stage.kind !== 'choose'}
            testID="question-types-start"
            style={styles.button}
            onPress={() => void start()}
          >
            {stage.kind === 'preparing' ? (
              <Text style={styles.buttonLabel}>{strings.questionTypesPreparing}</Text>
            ) : (
              <Text style={styles.buttonLabel}>{strings.questionTypesStart}</Text>
            )}
          </Pressable>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  list: { gap: spacing.xs, paddingBottom: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  rowOff: { backgroundColor: colors.background },
  box: { fontSize: fontSizes.lg, color: colors.primary },
  grow: { flex: 1 },
  name: { fontSize: fontSizes.md, color: colors.text, writingDirection: 'rtl' },
  nameOff: { color: colors.muted },
  meta: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  notice: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
  skipped: { gap: spacing.xs },
  button: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  buttonLabel: { color: colors.onPrimary, fontSize: fontSizes.md, fontWeight: '700' },
});
