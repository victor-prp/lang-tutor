import type { DiscoveryRun, DiscoverySelfLevel, DiscoveryState } from '@lang-tutor/core/api';
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { cardButton } from '@/components/BandCard';
import { DiscoverCard } from '@/components/DiscoverCard';
import { DiscoverEnd } from '@/components/DiscoverEnd';
import { DiscoverSheet } from '@/components/DiscoverSheet';
import { ScreenHeader } from '@/components/ScreenHeader';
import {
  DEFAULT_GOAL,
  GOAL_CHOICES,
  LEARNING_CONTEXTS,
  SELF_LEVELS,
  closeStep,
  endStep,
  savedBefore,
  stepOf,
  waitStep,
  warnEscape,
} from '@/discovery';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { useSession } from '@/hooks/useSession';
import { POLL_INTERVAL_MS } from '@/nextSession';
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
 * time (D2), how many words (D6), then rounds of cards (D5). Opening it again resumes the open
 * run at its step. Phase 74: a run the app starts (`from=my-words`, spec D6) skips how many;
 * each card is a choice and an add (D1, D2); ✕ ends a run with two words added or warns with
 * fewer (D8); the end shows what was added and starts the session once it is ready (D9).
 */
export default function DiscoverScreen() {
  const api = useApi();
  const { active } = useCurrentUser();
  const [state, setState] = useState<DiscoveryState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selfLevel, setSelfLevel] = useState<DiscoverySelfLevel | null>(null);
  const [goal, setGoal] = useState<number>(DEFAULT_GOAL);
  const [warning, setWarning] = useState(false);
  // Spec D9. The end asked for the session once; practising without new words waits on one.
  const [created, setCreated] = useState(false);
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const fetching = useRef(false);
  const starting = useRef(false);
  const enrollmentId = active?.id ?? null;
  const { from } = useLocalSearchParams<{ from?: string }>();
  // Phase 73 (spec D6), phase 74 (D6). Opened from the My words card, the app starts the run.
  const fromApp = from === 'my-words';
  const nextSession = useNextSession();
  const { enter } = useSession();
  const live = useRef(true);
  const opened = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

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
  const step = state ? stepOf(state, fromApp) : null;
  const run = state?.run ?? null;
  const runId = run?.id ?? null;

  // A run asking with every card answered fetches its next round, once at a time.
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

  // Spec D6. A run the app starts has no chips: it starts as soon as the questions are behind.
  useEffect(() => {
    if (step !== 'starting' || !enrollmentId || starting.current || failed) return;
    starting.current = true;
    api
      .startDiscovery(enrollmentId, null)
      .then((started) => {
        if (live.current) setRun(started);
      })
      .catch(() => {
        if (live.current) setFailed(true);
      })
      .finally(() => {
        starting.current = false;
      });
  }, [step, enrollmentId, failed, api, setRun]);

  const openSession = useCallback(
    (sessionId: string, fresh: boolean) => {
      if (!live.current || opened.current) return;
      opened.current = true;
      if (fresh) void nextSession.start(sessionId);
      enter(sessionId);
      // Replace, not push: back from the session lands on home, where discover sat.
      router.replace('/session');
    },
    [nextSession, enter],
  );

  // Spec D9. The end reads My words' session afresh, then follows it and the run's lookups.
  const current = nextSession.current?.current ?? null;
  const ending = step === 'end' && run ? endStep(run, current, created) : null;
  const atEnd = step === 'end';
  const { refresh, create } = nextSession;
  useEffect(() => {
    if (atEnd) void refresh();
  }, [atEnd, refresh]);
  const polling = ending === 'wait' || waitingFor !== null;
  useFocusEffect(
    useCallback(() => {
      if (!polling) return undefined;
      const timer = setInterval(() => {
        if (!live.current) return;
        void refresh();
        if (runId) {
          api
            .getDiscoveryRun(runId)
            .then((read) => {
              if (live.current) setRun(read);
            })
            .catch(() => {});
        }
      }, POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [polling, refresh, runId, api, setRun]),
  );
  useEffect(() => {
    if (ending !== 'create') return;
    setCreated(true);
    create()
      .then(() => refresh())
      .catch(() => {});
  }, [ending, create, refresh]);

  // Spec D8. Practising without new words: the session asked for opens once it is ready.
  const waitingStep = waitingFor ? waitStep(current, waitingFor) : 'wait';
  useEffect(() => {
    if (!waitingFor || !live.current) return;
    if (waitingStep === 'open') openSession(waitingFor, true);
    else if (waitingStep === 'home') router.dismissTo('/');
  }, [waitingFor, waitingStep, openSession]);

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
      setRun(await api.startDiscovery(active.id, goal));
    });

  const card = run?.cards[0] ?? null;

  const answer = (pick: number | null, add: boolean) =>
    guard(async () => {
      if (!run || !card) return;
      setRun(await api.answerDiscoveryCard(run.id, card.position, { pick, add }));
    });

  const endRun = () =>
    guard(async () => {
      if (run) setRun(await api.endDiscovery(run.id));
    });

  const close = () => {
    const what = closeStep(run, step ?? 'questions');
    if (what === 'leave') router.back();
    else if (what === 'warn') setWarning(true);
    else void endRun();
  };

  const escape = warnEscape(fromApp, savedBefore(nextSession.current?.saved_count ?? 0, run));
  const leaveAnyway = () => {
    setWarning(false);
    if (escape === 'leave') {
      router.back();
      return;
    }
    // Spec D8 (my call). The app sent a learner who has words: the run ends and the session they
    // came for opens, waiting while it is prepared.
    void guard(async () => {
      if (run) await api.endDiscovery(run.id);
      const session = await create().catch(() => null);
      if (!session) {
        router.dismissTo('/');
        return;
      }
      if (session.status === 'ready') openSession(session.session_id, true);
      else setWaitingFor(session.session_id);
    });
  };

  const startEnd = () => {
    if (current?.status === 'ready') openSession(current.session_id, current.answered === 0);
  };

  // Nothing read yet: read again. A round that failed: clearing the failure fetches it again.
  const retry = () => {
    if (state === null) void load();
    else setFailed(false);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.column}>
        <ScreenHeader title={strings.discoverTitle} onBack={close} backTestID="discover-close" close />

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

        {step === null || step === 'fetching' || step === 'starting' ? (
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
            choices={card.choices}
            right={card.right}
            added={strings.discoverAddedCount(run.added_count, run.goal)}
            busy={busy}
            onAnswer={(pick, add) => void answer(pick, add)}
          />
        ) : null}

        {step === 'end' && run && ending ? (
          <DiscoverEnd
            run={run}
            wordDirection={wordDirection}
            step={waitingFor ? 'wait' : ending}
            busy={busy}
            onStart={startEnd}
            onHome={() => router.back()}
          />
        ) : null}
      </View>

      <DiscoverSheet
        visible={warning}
        testID="discover-warn"
        title={strings.discoverWarnTitle}
        body={strings.discoverWarnBody}
        first={{
          label: escape === 'practise' ? strings.discoverWarnPractise : strings.discoverWarnLeave,
          testID: 'discover-warn-leave',
          onPress: leaveAnyway,
        }}
        second={{ label: strings.discoverWarnContinue, testID: 'discover-warn-continue', onPress: () => setWarning(false) }}
        onDismiss={() => setWarning(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.md },
  column: { flex: 1, gap: spacing.sm },
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
