import type { DiscoveryRun, DiscoverySelfLevel, DiscoveryState } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { cardButton } from '@/components/BandCard';
import { DiscoverCard } from '@/components/DiscoverCard';
import { DiscoverList } from '@/components/DiscoverList';
import { ScreenHeader } from '@/components/ScreenHeader';
import { confirm } from '@/confirm';
import { DEFAULT_GOAL, GOAL_CHOICES, LEARNING_CONTEXTS, SELF_LEVELS, canEnd, stepOf, verdictLine } from '@/discovery';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

/** One answer of a question: a white row, blue once picked. */
function Choice({ label, selected, testID, onPress }: { label: string; selected: boolean; testID: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      aria-selected={selected}
      testID={testID}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Phase 69. Words for me, one screen over the tabs (spec D1): the two questions the first
 * time (D2), how many words (D6), then rounds of cards (D5) until the run lists its words (D8).
 * Opening it again resumes the open run at its step; ✕ leaves it open.
 */
export default function DiscoverScreen() {
  const api = useApi();
  const { active } = useCurrentUser();
  const [state, setState] = useState<DiscoveryState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selfLevel, setSelfLevel] = useState<DiscoverySelfLevel | null>(null);
  const [goal, setGoal] = useState<number>(DEFAULT_GOAL);
  // A typed answer's verdict, and the run it left, shown until הבא.
  const [answered, setAnswered] = useState<{ verdict: { tone: 'right' | 'wrong'; text: string }; run: DiscoveryRun } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fetching = useRef(false);
  const enrollmentId = active?.id ?? null;

  const load = useCallback(async () => {
    if (!enrollmentId) return;
    setFailed(false);
    try {
      setState(await api.discoveryState(enrollmentId));
    } catch {
      setFailed(true);
    }
  }, [api, enrollmentId]);
  useEffect(() => {
    void load();
  }, [load]);

  const setRun = useCallback((run: DiscoveryRun) => setState((current) => (current ? { ...current, run } : current)), []);
  const step = state ? stepOf(state) : null;

  // A run asking with every card answered fetches its next round, once at a time.
  const runId = state?.run?.id ?? null;
  const nextRound = useCallback(async () => {
    if (!runId || fetching.current) return;
    fetching.current = true;
    setFailed(false);
    try {
      setRun(await api.nextDiscoveryRound(runId));
    } catch {
      setFailed(true);
    } finally {
      fetching.current = false;
    }
  }, [api, runId, setRun]);
  useEffect(() => {
    if (step === 'fetching' && !failed) void nextRound();
  }, [step, failed, nextRound]);

  if (!active) return <Redirect href="/" />;
  const language = active.target_language;
  const wordDirection = language === 'he' ? 'rtl' : 'ltr';

  const guard = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await work();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const answerProfile = (learningContext: (typeof LEARNING_CONTEXTS)[number]['value']) =>
    guard(async () => {
      if (!selfLevel) return;
      const profile = await api.createDiscoveryProfile(active.id, { self_level: selfLevel, learning_context: learningContext });
      setState((current) => ({ profile, run: current?.run ?? null }));
    });

  const start = () =>
    guard(async () => {
      const run = await api.startDiscovery(active.id, goal);
      setState((current) => (current ? { ...current, run } : current));
    });

  const run = state?.run ?? null;
  const card = run?.cards[0] ?? null;

  const answerUnknown = () =>
    guard(async () => {
      if (!run || !card) return;
      setNote(null);
      setRun((await api.answerDiscoveryCard(run.id, card.position, { kind: 'unknown' })).run);
    });

  const answerTyped = (text: string) => {
    if (busy || !run || !card) return;
    setBusy(true);
    setFailed(false);
    setNote(null);
    api
      .answerDiscoveryCard(run.id, card.position, { kind: 'typed', text })
      .then((result) => setAnswered({ verdict: verdictLine(result), run: result.run }))
      .catch((error: unknown) => {
        // A 422 is an answer in the wrong alphabet: nothing was recorded.
        if (error instanceof ApiError && error.status === 422) setNote(strings.discoverWriteHebrew);
        else setFailed(true);
      })
      .finally(() => setBusy(false));
  };

  const next = () => {
    if (!answered) return;
    setRun(answered.run);
    setAnswered(null);
  };

  const end = () =>
    guard(async () => {
      if (!run) return;
      setRun(await api.endDiscovery(run.id));
    });

  const save = (count: number) =>
    guard(async () => {
      if (!run) return;
      const { saved_gloss_ids } = await api.saveDiscovery(run.id);
      router.dismissTo({ pathname: '/', params: { photoSaved: String(saved_gloss_ids.length || count) } });
    });

  const discard = async () => {
    if (!run || busy) return;
    const sure = await confirm({
      title: strings.discoverDiscardTitle,
      message: strings.discoverDiscardMessage,
      confirm: strings.discoverDiscardConfirm,
      cancel: strings.discoverDiscardCancel,
    });
    if (!sure) return;
    await guard(async () => {
      await api.discardDiscovery(run.id);
      router.back();
    });
  };

  // Nothing read yet: read again. A round that failed: clearing the failure fetches it again.
  const retry = () => {
    if (state === null) void load();
    else setFailed(false);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.avoid} behavior="padding">
        <ScreenHeader title={strings.discoverTitle} onBack={() => router.back()} backTestID="discover-close" close />

        {failed ? (
          <View style={styles.failedRow}>
            <Text testID="discover-failed" style={styles.failed}>
              {strings.discoverFailed}
            </Text>
            <Pressable accessibilityRole="button" testID="discover-retry" onPress={retry}>
              <Text style={styles.link}>{strings.tryAgain}</Text>
            </Pressable>
          </View>
        ) : null}

        {step === null || step === 'fetching' ? (
          failed ? null : (
            <View testID="discover-fetching" style={styles.center}>
              <ActivityIndicator color={colors.primary} />
              {step === 'fetching' ? <Text style={styles.muted}>{strings.discoverFetching}</Text> : null}
            </View>
          )
        ) : null}

        {step === 'questions' ? (
          <ScrollView contentContainerStyle={styles.body}>
            <Text testID="discover-question" style={styles.question}>
              {selfLevel === null ? strings.discoverLevelQuestion(language) : strings.discoverContextQuestion(language)}
            </Text>
            <View style={styles.choices}>
              {selfLevel === null
                ? SELF_LEVELS.map((option) => (
                    <Choice
                      key={option.value}
                      label={option.label}
                      selected={false}
                      testID={`discover-option-${option.value}`}
                      onPress={() => setSelfLevel(option.value)}
                    />
                  ))
                : LEARNING_CONTEXTS.map((option) => (
                    <Choice
                      key={option.value}
                      label={option.label}
                      selected={false}
                      testID={`discover-option-${option.value}`}
                      onPress={() => void answerProfile(option.value)}
                    />
                  ))}
            </View>
          </ScrollView>
        ) : null}

        {step === 'goal' ? (
          <ScrollView contentContainerStyle={styles.body}>
            <Text testID="discover-question" style={styles.question}>
              {strings.discoverGoalQuestion}
            </Text>
            <View style={styles.goals}>
              {GOAL_CHOICES.map((choice) => (
                <Pressable
                  key={choice}
                  accessibilityRole="button"
                  accessibilityState={{ selected: goal === choice }}
                  aria-selected={goal === choice}
                  testID={`discover-goal-${choice}`}
                  onPress={() => setGoal(choice)}
                  style={[styles.goal, goal === choice && styles.choiceSelected]}
                >
                  <Text style={[styles.goalLabel, goal === choice && styles.choiceLabelSelected]}>{strings.discoverGoal(choice)}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              testID="discover-start"
              disabled={busy}
              onPress={() => void start()}
              style={[cardButton.solid, busy && cardButton.disabled]}
            >
              <Text style={cardButton.solidLabel}>{strings.discoverStart}</Text>
            </Pressable>
          </ScrollView>
        ) : null}

        {step === 'card' && run && card ? (
          <DiscoverCard
            key={card.position}
            word={card.word}
            wordDirection={wordDirection}
            found={strings.discoverFound((answered?.run ?? run).unknown_count, run.goal)}
            verdict={answered?.verdict ?? null}
            note={note}
            busy={busy}
            canEnd={answered === null && canEnd(run)}
            onCheck={answerTyped}
            onDontKnow={() => void answerUnknown()}
            onNext={next}
            onEnd={() => void end()}
          />
        ) : null}

        {step === 'list' && run ? (
          <DiscoverList
            run={run}
            wordDirection={wordDirection}
            busy={busy}
            onRun={setRun}
            onSave={(count) => void save(count)}
            onDiscard={() => void discard()}
          />
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.md },
  avoid: { flex: 1, gap: spacing.sm },
  body: { gap: spacing.md, paddingVertical: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  muted: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
  question: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '800', color: colors.text, writingDirection: 'rtl' },
  choices: { gap: spacing.sm },
  choice: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    ...shadows.card,
  },
  choiceSelected: { backgroundColor: colors.primary },
  choiceLabel: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  choiceLabelSelected: { color: colors.onPrimary, fontWeight: '700' },
  goals: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  goal: {
    minWidth: 64,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    ...shadows.card,
  },
  goalLabel: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  failed: { flex: 1, fontSize: fontSizes.sm, color: colors.wrong, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
});
