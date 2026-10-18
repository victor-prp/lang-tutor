import type { CurrentSessionResponse, Enrollment, TargetSummary } from '@lang-tutor/core/api';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text } from 'react-native';

import { ApiError } from '@/api/client';
import { CardStack } from '@/components/CardStack';
import { MyWordsCard } from '@/components/MyWordsCard';
import { TargetCard } from '@/components/TargetCard';
import { useNextSession } from '@/hooks/useNextSession';
import { useSession } from '@/hooks/useSession';
import { useTargets } from '@/hooks/useTargets';
import {
  POLL_INTERVAL_MS,
  createLook,
  homeActionOf,
  homeReminderStartOf,
  mainEmptyNote,
  openSessionOf,
  shouldAutoCreate,
  shouldPoll,
  targetPress,
  targetSessionAction,
  type HomeAction,
  type TargetCreate,
} from '@/nextSession';
import { strings } from '@/strings';
import { homeOrder, shouldPollTargets, stackBars, type HomeCard } from '@/targets';
import { colors, fontSizes, lineHeights } from '@/theme';

/** Final review N1. Create refused: the path has a started session (409 session_open). */
const isSessionOpen = (error: unknown) => error instanceof ApiError && error.code === 'session_open';

/** Phase 52 (spec D8), phase 57. What home holds of a tapped reminder: the main path's read it
 *  first saw, the targets read made after the tap (its list), and the create a target first
 *  goes through. */
type ReminderHeld = {
  read: CurrentSessionResponse | null;
  targets: 'reading' | 'failed' | readonly TargetSummary[];
  created: TargetCreate;
};

export function LearningSection({ active }: { active: Enrollment }) {
  const { enter } = useSession();
  const next = useNextSession();
  const { list: targetList, reload: reloadTargets, create: createTargetSession } = useTargets();
  // Set by the review after a save (spec D13): "28 words saved".
  const { photoSaved, start } = useLocalSearchParams<{ photoSaved?: string; start?: string }>();
  // Phase 52 (spec D8). Home's own route, so the param is cleared here even if
  // another screen has been opened over home since: router.setParams would clear
  // the focused screen's.
  const navigation = useNavigation<{ setParams: (params: { start?: string }) => void }>();
  const focused = useIsFocused();
  // A ref guards re-entry (state is stale between two taps in one frame); the
  // state only drives the disabled look.
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // Phase 43 (spec D7). The enrollment home sent its own create for in this
  // focus, and the one whose create failed: a missing session is made once per
  // focus, then offered as a retry.
  const attemptedFor = useRef<string | null>(null);
  const [makeFailedFor, setMakeFailedFor] = useState<string | null>(null);
  // Phase 52 (spec D8). `start=reminder` is acted on once: the param is cleared
  // as it is, and this holds the render or two before the clear reaches `start`.
  const reminderHandled = useRef(false);
  // The read home held when it first saw the param. It may be about a session
  // finished since, so home reads again and acts on the first read that differs
  // (every successful read stores a new object). Phase 57 (spec D2): the targets are
  // read again too, since the first card's path is the one opened, and `targets` holds
  // that read's list itself (final review CI-1: a render's list can be older than the
  // read); `created` is the create a target first goes through (C1). The tick
  // re-renders home when either lands.
  const reminderHeld = useRef<ReminderHeld | null>(null);
  const [, setReminderTick] = useState(0);

  // Fresh on every focus: back from a session, from translate, after a switch.
  // The reloads change with the active enrollment, so a switch runs this
  // again, and the providers keep each read under the enrollment it was for,
  // so that read is the one shown. Phase 53: the targets too, back from a target
  // or the wizard. Their reload never rejects, and the effect returns nothing.
  const { reload } = next;
  useFocusEffect(
    useCallback(() => {
      attemptedFor.current = null;
      setMakeFailedFor(null);
      reload();
      void reloadTargets();
    }, [reload, reloadTargets]),
  );

  // While preparing, and only while this screen is focused.
  const polling = shouldPoll(next.current);
  useFocusEffect(
    useCallback(() => {
      if (!polling) return undefined;
      const timer = setInterval(reload, POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [polling, reload]),
  );

  // Phase 57. A target's session is prepared the same way: its card moves while it is.
  const targetsPolling = shouldPollTargets(targetList);
  useFocusEffect(
    useCallback(() => {
      if (!targetsPolling) return undefined;
      const timer = setInterval(() => void reloadTargets(), POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [targetsPolling, reloadTargets]),
  );

  const action: HomeAction | null = next.current ? homeActionOf(next.current) : null;
  // Phase 57 (spec D11). One card per path, by priority; phase 64 (spec D3) shows them as a
  // stack, one at a time, in that order.
  const targets = targetList?.targets ?? [];
  const { order } = homeOrder(targets);
  const bars = stackBars(order, targets);

  // Phase 43 (spec D2). A session not yet answered is started, which has the
  // next one built for this device. Not waited on: its first answer starts it too.
  function enterSession(sessionId: string, fresh: boolean) {
    if (fresh) void next.start(sessionId);
    enter(sessionId);
    router.push('/session');
  }

  // One action at a time: a double tap must not send two creates. The server
  // would refuse the second one anyway (session_open).
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not enough questions') {
        Alert.alert(strings.errorTitle, strings.sessionNoQuestions);
      }
      // Anything else: home re-reads the state (create and skip both reload),
      // and that state is the explanation.
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // The seed's cards are fixed, so its create does not wait on the voices: the
  // start it is entered with waits instead, without holding the tap.
  const startSeed = () =>
    run(async () => {
      const created = await next.create({ waitForVoices: false });
      if (created.status === 'ready') enterSession(created.session_id, true);
    });
  // Phase 43 (spec D7). Makes the next session without entering it: home shows
  // it preparing, then offers it.
  const makeNext = (enrollmentId: string) =>
    run(async () => {
      try {
        await next.create();
        setMakeFailedFor(null);
      } catch (error) {
        setMakeFailedFor(enrollmentId);
        throw error;
      }
    });
  // A skip from home can leave no session at all (the one in stock skipped):
  // home may make the next one again in this focus.
  const skip = (sessionId: string) =>
    run(async () => {
      await next.skip(sessionId);
      attemptedFor.current = null;
    });

  // Phase 57 (spec D1). A target's button acts on its own path's session: a started one is
  // resumed; otherwise it goes through create with the target's id (final review C1: create
  // answers the path's stock, replaced first when it no longer serves the target's day, or
  // builds one), and the session create answers is entered when ready, else the card shows
  // it preparing (home polls the targets meanwhile). A preparing one is not pressable.
  // Final review N1: a create refused with session_open means the path has a started session
  // after all (the card's list predates the start); the list read again names it, and it is
  // entered as it is.
  const practiceTarget = (target: TargetSummary) => {
    const press = targetPress(targetSessionAction(target));
    if (press.kind === 'enter') enterSession(press.sessionId, press.fresh);
    if (press.kind !== 'create') return;
    void run(async () => {
      try {
        const created = await createTargetSession(target.id, { waitForVoices: press.waitForVoices });
        if (created.status === 'ready') enterSession(created.session_id, true);
      } catch (error) {
        if (!isSessionOpen(error)) throw error;
        const open = openSessionOf((await reloadTargets())?.targets ?? null, target.id);
        if (open) enterSession(open, false);
      }
    });
  };

  // Phase 43 (spec D7). A missing session is made, not offered as a button.
  // After every render: the guard sends it once per focus and enrollment, and
  // waits out another action in flight rather than being swallowed by it.
  useEffect(() => {
    if (inFlight.current || !shouldAutoCreate(action, attemptedFor.current, active.id)) return;
    attemptedFor.current = active.id;
    void makeNext(active.id);
  });

  // Phase 52 (spec D8). A tapped reminder opens home with start=reminder. Home
  // reads the session again, then does what its start button does with that
  // read, and clears the param, so a re-render or a return to home does not
  // start again. With nothing to start the param is just cleared; until then it
  // waits. After every render, like the guard above, and only while home is focused.
  // Phase 57 (spec D2): it opens the first card's path, so the targets are read again
  // as well, and that read's own list decides which card is first (final review CI-1). A
  // target first goes through create, as its card's button does (C1), and is waited for
  // while it prepares.
  useEffect(() => {
    if (start !== 'reminder') {
      reminderHandled.current = false;
      reminderHeld.current = null;
      return;
    }
    if (!focused || reminderHandled.current || inFlight.current) return;
    if (reminderHeld.current === null) {
      const fresh: ReminderHeld = { read: next.current, targets: 'reading', created: { kind: 'none' } };
      reminderHeld.current = fresh;
      reload();
      void reloadTargets().then((list) => {
        if (reminderHeld.current !== fresh) return;
        fresh.targets = list ? list.targets : 'failed';
        setReminderTick((tick) => tick + 1);
      });
    }
    const held = reminderHeld.current;
    const step = homeReminderStartOf(
      held.targets,
      action,
      {
        failed: next.loadFailed || createLook(makeFailedFor, active.id) === 'retry',
        read: next.current !== held.read,
      },
      held.created,
      targets,
    );
    if (step.kind === 'wait') return;
    if (step.kind === 'create') {
      held.created = { kind: 'sending' };
      const landed = (created: TargetCreate) => {
        if (reminderHeld.current !== held) return;
        held.created = created;
        setReminderTick((tick) => tick + 1);
      };
      void createTargetSession(step.targetId, { waitForVoices: step.waitForVoices }).then(
        (created) => landed({ kind: 'answered', sessionId: created.session_id, status: created.status }),
        async (error: unknown) => {
          // Final review N1: refused because the path has a started session; enter it.
          const open = isSessionOpen(error) ? openSessionOf((await reloadTargets())?.targets ?? null, step.targetId) : null;
          landed(open ? { kind: 'open', sessionId: open } : { kind: 'failed' });
        },
      );
      return;
    }
    reminderHandled.current = true;
    navigation.setParams({ start: undefined });
    if (step.kind === 'enter') enterSession(step.sessionId, step.fresh);
  });

  // Phase 64 (spec D3, D4). Each card of the stack: My words with today's machinery as it was,
  // or a target's card with its own path's button.
  const cardNode = (card: HomeCard) => {
    if (card === 'main') {
      return (
        <MyWordsCard
          current={next.current}
          language={strings.languageName(active.target_language)}
          action={action}
          emptyNote={mainEmptyNote(targetList?.targets ?? null)}
          loadFailed={next.loadFailed}
          busy={busy}
          onRetry={reload}
          makeFailed={createLook(makeFailedFor, active.id) === 'retry'}
          onStartSeed={startSeed}
          onMake={() => void makeNext(active.id)}
          onEnter={enterSession}
          onSkip={skip}
        />
      );
    }
    const target = targets.find((candidate) => candidate.id === card);
    return target ? (
      <TargetCard
        target={target}
        busy={busy}
        onOpen={() => router.push(`/targets/${target.id}`)}
        onPractice={() => practiceTarget(target)}
      />
    ) : null;
  };

  return (
    <>
      <CardStack resetKey={order.join(',')} bars={bars} cards={order.map((card) => ({ key: card, node: cardNode(card) }))} />

      {photoSaved ? (
        <Text testID="home-photo-saved" style={styles.notice}>
          {strings.photoImportSaved(Number(photoSaved))}
        </Text>
      ) : null}


    </>
  );
}

const styles = StyleSheet.create({
  notice: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
});
