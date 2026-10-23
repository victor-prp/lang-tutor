import type { CurrentSessionResponse, MissedQuestion, SessionProgressItem, TargetSummary } from '@lang-tutor/core/api';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { cardButton } from '@/components/BandCard';
import { LevelBadge } from '@/components/LevelBadge';
import { MyWordsToday } from '@/components/MyWordsToday';
import { PracticeMoreSheet } from '@/components/PracticeMoreSheet';
import { SpeakButton } from '@/components/SpeakButton';
import { Readiness, Sessions } from '@/components/TargetCard';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { usePracticeMyWords } from '@/hooks/usePracticeMyWords';
import { usePracticeTarget } from '@/hooks/usePracticeTarget';
import { useSession } from '@/hooks/useSession';
import { useTargets } from '@/hooks/useTargets';
import { homeActionOf, POLL_INTERVAL_MS, targetSessionAction } from '@/nextSession';
import { missedPair, practisedRows } from '@/progress';
import { hasToday } from '@/myWordsToday';
import { myWordsContinue, resultsScreenOf } from '@/resultsMyWords';
import { strings } from '@/strings';
import { continueButton, resultsTarget, targetCardState } from '@/targets';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

function headlineFor(correct: number, total: number): string {
  const ratio = total === 0 ? 0 : correct / total;
  if (ratio >= 0.9) return strings.resultsHeadlineGreat;
  if (ratio >= 0.6) return strings.resultsHeadlineGood;
  return strings.resultsHeadlineKeepPractising;
}

/** What the screen draws of the session it was opened for. */
type Finished = {
  correctCount: number;
  total: number;
  missedQuestions: MissedQuestion[];
  progress: SessionProgressItem[];
  targetId: string | null;
  source: 'seed' | 'list' | null;
  kind: 'practice' | 'question_types' | undefined;
};

export default function ResultsScreen() {
  const session = useSession();
  // Voice phase. A practised row's form and a missed row's word are in the
  // active enrollment's target language, whatever the card's type.
  const { active } = useCurrentUser();
  const language = active?.target_language ?? null;
  // Phase 72 (spec D2). The session as it ended, kept from the first render: continuing enters the
  // next session, which replaces the shared state at once, while this screen is still on its way out.
  const [finished] = useState<Finished | null>(() =>
    session.hasSession
      ? {
          correctCount: session.correctCount,
          total: session.total,
          missedQuestions: session.missedQuestions,
          progress: session.progress,
          targetId: session.targetId,
          source: session.source,
          kind: session.kind,
        }
      : null,
  );
  const targetId = finished?.targetId ?? null;
  const myWordsScreen = finished !== null && resultsScreenOf(finished) === 'my-words';
  const next = useNextSession();
  const { list, reload } = useTargets();
  // Phase 72 (spec D2). Home's numbers come from a read made after the session ended: the list a
  // render holds before it lands can be home's read from before the session, and is not shown.
  const [read, setRead] = useState<'reading' | 'failed' | 'landed'>('reading');
  const view = resultsTarget(targetId, read === 'landed' && list ? list : read === 'failed' ? 'failed' : 'reading');
  const target = view.kind === 'target' ? view.target : null;
  const action = target ? targetSessionAction(target) : null;

  useFocusEffect(
    useCallback(() => {
      if (targetId === null) return;
      void reload().then((landed) => setRead((was) => (landed ? 'landed' : was === 'landed' ? was : 'failed')));
    }, [targetId, reload]),
  );

  // Phase 73 (spec D7). The same wait for My words: the block and the button come from a read made
  // after the session ended, not from the one home held before it.
  const [myWordsRead, setMyWordsRead] = useState<'reading' | 'failed' | 'landed'>('reading');
  const { refresh } = next;
  useFocusEffect(
    useCallback(() => {
      if (!myWordsScreen) return;
      void refresh().then((landed) => setMyWordsRead((was) => (landed ? 'landed' : was === 'landed' ? was : 'failed')));
    }, [myWordsScreen, refresh]),
  );
  // A failed read is read again on a press; while it is in flight the button waits.
  const rereadMyWords = () => {
    setMyWordsRead('reading');
    void refresh().then((landed) => setMyWordsRead(landed ? 'landed' : 'failed'));
  };
  const myWordsLanded = myWordsScreen && myWordsRead === 'landed';
  const myWordsAction = myWordsLanded && next.current ? homeActionOf(next.current) : null;
  const myWordsState = myWordsContinue(myWordsScreen ? myWordsRead : 'reading', myWordsAction);
  const myWordsPreparing = myWordsState === 'preparing';
  useFocusEffect(
    useCallback(() => {
      if (!myWordsPreparing) return undefined;
      const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [myWordsPreparing, refresh]),
  );

  // Phase 72 (spec D2). As home does: read again while the target's next session is prepared.
  const preparing = action?.kind === 'preparing';
  useFocusEffect(
    useCallback(() => {
      if (!preparing) return undefined;
      const timer = setInterval(() => void reload(), POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [preparing, reload]),
  );

  // Phase 72 (final review I1). Whether this screen is still the one shown. A press still on its way
  // when the learner left (סיום, back) opens nothing: a late replace would take home's place in the
  // stack, and back from the session would have nowhere to go. The stock waits on home's card.
  const shown = useRef(true);
  useFocusEffect(
    useCallback(() => {
      shown.current = true;
      return () => {
        shown.current = false;
      };
    }, []),
  );

  // One action at a time, as home's: a double tap must not send two creates.
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      // Phase 72 (spec D5). The target ended since: home shows what is left. Anything else: the
      // create read the targets again, and the button shows that state.
      if (error instanceof ApiError && error.code === 'target closed' && shown.current) router.dismissTo('/');
      if (error instanceof ApiError && error.code === 'not enough questions') {
        Alert.alert(strings.errorTitle, strings.sessionNoQuestions);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // Phase 72 (spec D3). The next session in place of this screen: the stack stays home → session.
  const openSession = (sessionId: string, fresh: boolean) => {
    if (!shown.current) return;
    if (fresh) void next.start(sessionId);
    session.enter(sessionId);
    router.replace('/session');
  };
  const { practice, asking, answerAsk, cancelAsk } = usePracticeTarget({ run, openSession });
  // Phase 73 (spec D7, D8). My words' button: the press home's card makes. Nothing to skip here, and a
  // learner left with no words goes home, which shows its state.
  const myWords = usePracticeMyWords({
    run,
    openSession,
    // Like home's card: Words for me, from My words.
    onDiscover: () => {
      if (shown.current) router.replace({ pathname: '/discover', params: { from: 'my-words' } });
    },
    onSkipped: () => undefined,
  });

  if (finished === null) {
    return <Redirect href="/" />;
  }

  const { correctCount, total, missedQuestions, progress } = finished;

  // Phase 43 (spec D7). Home, where the next session waits in stock: it was
  // built while this one was played. When it is not there, home makes it, or
  // says why there is none (no saved words).
  function onNextSession() {
    router.dismissTo('/');
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.headline}>{headlineFor(correctCount, total)}</Text>
        <Text style={styles.score} testID="results-score">{strings.scoreLabel(correctCount, total)}</Text>

        {target ? <TargetBlock target={target} /> : null}
        {myWordsLanded && next.current?.today && hasToday(next.current.today) ? (
          <MyWordsBlock today={next.current.today} />
        ) : null}
        {myWordsScreen && myWordsRead === 'reading' ? (
          <View style={[styles.target, styles.targetReading]} testID="results-my-words-reading">
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : null}
        {view.kind === 'reading' ? (
          <View style={[styles.target, styles.targetReading]} testID="results-target-reading">
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : null}

        {progress.length > 0 ? (
          <View style={styles.missed} testID="practised-section">
            <Text style={styles.missedTitle}>{strings.resultsPractisedTitle}</Text>
            {practisedRows(progress).map((row) => (
              <View
                key={row.gloss_id}
                style={[styles.missedRow, row.badgeRaised && styles.raisedRow, row.progressed && styles.progressedRow]}
                testID="practised-row"
              >
                <View style={[styles.missedCellStart, styles.spoken]}>
                  <Text style={[styles.missedPrompt, styles.shrink]}>{row.form}</Text>
                  {language ? <SpeakButton text={row.form} language={language} testID="speak-practised" /> : null}
                </View>
                <View style={styles.missedCellEnd}>
                  <Text style={styles.missedAnswer}>{row.translation}</Text>
                  <LevelBadge level={row.level_after} testID="practised-level" />
                  {row.badgeRaised ? (
                    <Text style={styles.raised} testID="practised-raised">
                      {strings.levelRaised(row.level_after)}
                    </Text>
                  ) : null}
                  {/* Phase 23 (spec D11): a dimension rose, the badge did not. */}
                  {row.progressed ? (
                    <Text style={styles.progressed} testID="practised-progressed">
                      {strings.dimensionsRaised(row.raised)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {missedQuestions.length > 0 ? (
          <View style={styles.missed}>
            <Text style={styles.missedTitle}>{strings.resultsMissedTitle}</Text>
            {missedQuestions.map((missed) => {
              const { word, meaning } = missedPair(missed);
              return (
                <View key={missed.question.id} style={styles.missedRow} testID="missed-row">
                  <View style={[styles.missedCellStart, styles.spoken]}>
                    <Text style={[styles.missedPrompt, styles.shrink]}>{word}</Text>
                    {language ? <SpeakButton text={word} language={language} testID="speak-missed" /> : null}
                  </View>
                  <View style={styles.missedCellEnd}>
                    <Text style={styles.missedAnswer}>{meaning}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        {myWordsScreen ? (
          <MyWordsContinueButton
            state={myWordsState}
            busy={busy}
            onPress={() =>
              myWordsState === 'retry-read' ? rereadMyWords() : myWordsAction && (myWordsState === 'retry' ? void myWords.makeNext() : myWords.press(myWordsAction))
            }
          />
        ) : view.kind === 'none' ? (
          <Pressable
            accessibilityRole="button"
            testID="results-next-session"
            onPress={onNextSession}
            style={styles.primary}
          >
            <Text style={styles.primaryLabel}>{strings.nextSession}</Text>
          </Pressable>
        ) : (
          <ContinueButton
            target={target}
            preparing={preparing}
            failed={action?.kind === 'failed'}
            busy={busy}
            onPress={() => target && practice(target)}
          />
        )}
        <Pressable
          accessibilityRole="button"
          testID="results-done"
          // dismissTo, not replace: Results sits on top of the home that
          // started the session, and replacing it would leave that home
          // stale underneath a second one.
          onPress={() => router.dismissTo('/')}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>{strings.done}</Text>
        </Pressable>
      </View>
      {/* Phase 72 (spec D4). Home's question past the day's budget; "אחזור מחר" means done for today. */}
      <PracticeMoreSheet
        visible={asking}
        onLater={(stop) => {
          answerAsk(stop, false);
          router.dismissTo('/');
        }}
        onAnyway={(stop) => answerAsk(stop, true)}
        onCancel={cancelAsk}
      />
    </SafeAreaView>
  );
}

/** Phase 72 (spec D2). What home's card says of the target: its countdown, its readiness and
 *  today's line, drawn by the card's own parts from the same read. */
function TargetBlock({ target }: { target: TargetSummary }) {
  const card = targetCardState(target);
  return (
    <View style={styles.target} testID="results-target">
      <Text style={styles.targetTitle}>
        {card.title.before}
        {card.title.number}
        {card.title.after}
      </Text>
      <Readiness target={target} readiness={card.readiness} />
      <Sessions target={target} />
    </View>
  );
}

/** Phase 73 (spec D7). The day's block: its title over the line, dots and tiles home's card draws. */
function MyWordsBlock({ today }: { today: NonNullable<CurrentSessionResponse['today']> }) {
  return (
    <View style={styles.target} testID="results-my-words">
      <Text style={styles.targetTitle}>{strings.myWordsResultsTitle}</Text>
      <MyWordsToday today={today} testID="results-my-words-today" />
    </View>
  );
}

/** Phase 73 (spec D7). Always filled, `להמשיך לתרגל`; the preparing look while the next session is
 *  built, the retry after a failed one, disabled until the read lands. */
function MyWordsContinueButton({
  state,
  busy,
  onPress,
}: {
  state: ReturnType<typeof myWordsContinue>;
  busy: boolean;
  onPress: () => void;
}) {
  const preparing = state === 'preparing';
  const disabled = state === 'waiting' || preparing || busy;  // 'retry-read' stays pressable
  return (
    <>
      {state === 'retry' ? <Text style={styles.failed}>{strings.preparationFailed}</Text> : null}
      <Pressable
        accessibilityRole="button"
        testID="results-continue"
        disabled={disabled}
        onPress={onPress}
        style={[cardButton.solid, preparing && styles.preparing, disabled && cardButton.disabled]}
      >
        {preparing ? <ActivityIndicator color={colors.onPrimary} /> : null}
        <Text style={cardButton.solidLabel}>
          {preparing ? strings.preparingQuestions : state === 'retry' ? strings.translateRetry : strings.continuePractising}
        </Text>
      </Pressable>
    </>
  );
}

/** Phase 72 (spec D3, D5). The continue button: home's label and look for the target, its preparing
 *  look while the next session is built, its retry after a failed one; disabled until the read lands. */
function ContinueButton({
  target,
  preparing,
  failed,
  busy,
  onPress,
}: {
  target: TargetSummary | null;
  preparing: boolean;
  failed: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const look = target ? continueButton(target) : { label: strings.continuePractising, filled: true };
  const box = look.filled ? cardButton.solid : cardButton.pale;
  const text = look.filled ? cardButton.solidLabel : cardButton.paleLabel;
  const disabled = target === null || preparing || busy;
  return (
    <>
      {failed ? <Text style={styles.failed}>{strings.preparationFailed}</Text> : null}
      <Pressable
        accessibilityRole="button"
        testID="results-continue"
        disabled={disabled}
        onPress={onPress}
        style={[box, preparing && styles.preparing, disabled && cardButton.disabled]}
      >
        {preparing ? <ActivityIndicator color={look.filled ? colors.onPrimary : colors.primary} /> : null}
        <Text style={text}>{preparing ? strings.preparingQuestions : failed ? strings.translateRetry : look.label}</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg },
  body: { paddingTop: spacing.xxl, paddingBottom: spacing.xl, gap: spacing.md },
  headline: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  score: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.primary,
    textAlign: 'center',
    // Direction is handled in the string itself: see strings.scoreLabel.
  },
  missed: { marginTop: spacing.lg, gap: spacing.sm },
  missedTitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
    color: colors.muted,
    writingDirection: 'rtl',
  },
  missedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  // The English side sits at the start of the row (the right, under RTL) and
  // keeps an LTR base direction so its punctuation stays put; the Hebrew side
  // takes the remaining half. Alignment comes from these flex cells rather
  // than a physical textAlign, which native RTL would swap.
  missedCellStart: { flex: 1, alignItems: 'flex-start' },
  missedCellEnd: { flex: 1, alignItems: 'flex-end' },
  spoken: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  shrink: { flexShrink: 1 },
  missedPrompt: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.text,
    writingDirection: 'ltr',
  },
  missedAnswer: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
  raisedRow: { borderColor: colors.primary, borderWidth: 2 },
  progressedRow: { borderColor: colors.primary },
  raised: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    fontWeight: '700',
    color: colors.primary,
    writingDirection: 'rtl',
  },
  progressed: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    color: colors.primary,
    writingDirection: 'rtl',
  },
  // Phase 72 (spec D2). Home's card look: white, rounded, on its soft shadow.
  target: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    padding: 15,
    gap: spacing.sm,
    marginTop: spacing.md,
    ...shadows.card,
  },
  targetReading: { minHeight: 160, justifyContent: 'center' },
  targetTitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  preparing: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  failed: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  actions: { paddingBottom: spacing.lg, gap: spacing.sm },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  primaryLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: {
    color: colors.muted,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
});
