import type { TargetSummary } from '@lang-tutor/core/api';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PracticeMoreSheet } from '@/components/PracticeMoreSheet';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { isSessionOpen } from '@/hooks/usePracticeTarget';
import { useSession } from '@/hooks/useSession';
import { useTargets } from '@/hooks/useTargets';
import { POLL_INTERVAL_MS, homeActionOf, openSessionOf, practiceStartOf, shouldPoll, type TargetCreate } from '@/nextSession';
import { strings } from '@/strings';
import { askBeforePracticeMore } from '@/targets';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

/** Whether the "practice more" question was weighed for this target's create: not yet, being
 *  weighed or shown, or answered "practise anyway" (or never needed). */
type Ask = 'unweighed' | 'weighing' | 'asking' | 'go';

/**
 * Phase 75 (spec D6). Where a tapped reminder that names its path goes: home opens it over itself,
 * and it opens that path's session in its own place, as phase 72's results screen does, so back
 * from the session lands on home. It switches to the reminder's course when another is active,
 * reads the path again, and then does what that card's button does now (practiceStartOf): asks
 * the "practice more" question when the card would, makes a failed session again, waits while one
 * prepares. With nothing to open (the target ended, the course is gone, a read failed) it goes
 * home, which shows what is left.
 */
export default function PracticeScreen() {
  const params = useLocalSearchParams<{ enrollment?: string; target?: string }>();
  const enrollmentId = params.enrollment ?? null;
  const targetId = params.target ?? null;
  const { active, enrollments, switchTo, user, practiceMoreAsk } = useCurrentUser();
  const next = useNextSession();
  const targets = useTargets();
  const { enter } = useSession();

  // The reads made after this screen opened, for the reminder's course: never one from before.
  const [held, setHeld] = useState<'reading' | 'failed' | readonly TargetSummary[]>('reading');
  const [main, setMain] = useState<'reading' | 'failed' | 'read'>('reading');
  const [created, setCreated] = useState<TargetCreate>({ kind: 'none' });
  const [made, setMade] = useState<'none' | 'sending' | 'failed'>('none');
  const [ask, setAsk] = useState<Ask>('unweighed');
  const readsStarted = useRef(false);
  const switched = useRef(false);
  // Once the screen has left for the session, home or Words for me, nothing more is done.
  const done = useRef(false);

  const here = active !== null && active.id === enrollmentId;
  const known = enrollmentId !== null && enrollments.some((enrollment) => enrollment.id === enrollmentId);

  function leave(to: 'home' | 'discover' | { sessionId: string; fresh: boolean }) {
    if (done.current) return;
    done.current = true;
    if (to === 'home') {
      if (router.canDismiss()) router.dismissTo('/');
      else router.replace('/');
    } else if (to === 'discover') {
      router.replace({ pathname: '/discover', params: { from: 'my-words' } });
    } else {
      // Phase 43 (spec D2). A session not yet answered is started, as home starts it.
      if (to.fresh) void next.start(to.sessionId);
      enter(to.sessionId);
      router.replace('/session');
    }
  }

  // The reminder's course first: its reads are the ones the providers keep for the active one.
  useEffect(() => {
    if (done.current || here) return;
    if (enrollments.length > 0 && !known) leave('home');
    else if (known && enrollmentId !== null && !switched.current) {
      switched.current = true;
      switchTo(enrollmentId);
    }
  });

  // Then the path's read, once, made now.
  useEffect(() => {
    if (!here || readsStarted.current) return;
    readsStarted.current = true;
    if (targetId !== null) {
      void targets.reload().then((list) => setHeld(list ? list.targets : 'failed'));
    } else {
      void next.refresh().then((landed) => setMain(landed ? 'read' : 'failed'));
    }
  }, [here, targetId, targets, next]);

  // While a session prepares, as home polls it.
  const latest = targets.list?.targets ?? [];
  const pollMain = here && targetId === null && main === 'read' && shouldPoll(next.current);
  const pollTargets = here && created.kind === 'answered' && created.status === 'preparing';
  const { reload } = next;
  const reloadTargets = targets.reload;
  useEffect(() => {
    if (!pollMain && !pollTargets) return undefined;
    const timer = setInterval(() => (pollMain ? reload() : void reloadTargets()), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollMain, pollTargets, reload, reloadTargets]);

  const step = here
    ? practiceStartOf({
        targetId,
        targets: held,
        main: main === 'read' && next.current ? homeActionOf(next.current) : null,
        flags: { failed: main === 'failed', read: main === 'read' },
        created,
        made,
        latest,
      })
    : ({ kind: 'wait' } as const);

  // After every render, as home's reminder: each step is acted on once, the state it sets
  // moving the next render on.
  useEffect(() => {
    if (done.current) return;
    switch (step.kind) {
      case 'wait':
        return;
      case 'home':
        return leave('home');
      case 'discover':
        return leave('discover');
      case 'enter':
        return leave({ sessionId: step.sessionId, fresh: step.fresh });
      case 'make':
        setMade('sending');
        void next.create().catch(() => setMade('failed'));
        return;
      case 'create': {
        if (ask === 'weighing' || ask === 'asking') return;
        const summary = held === 'reading' || held === 'failed' ? undefined : held.find((candidate) => candidate.id === step.targetId);
        // Phase 65 (spec D9). Past the day's budget, when another session adds little, the card
        // asks first, unless the learner turned that off; a storage failure reads as "ask".
        if (ask === 'unweighed' && summary && askBeforePracticeMore(summary, false)) {
          setAsk('weighing');
          void (user ? practiceMoreAsk.shouldAsk(user.username) : Promise.resolve(true)).then((asks) =>
            setAsk(askBeforePracticeMore(summary, !asks) ? 'asking' : 'go'),
          );
          return;
        }
        setCreated({ kind: 'sending' });
        void targets.create(step.targetId, { waitForVoices: step.waitForVoices }).then(
          (answer) => setCreated({ kind: 'answered', sessionId: answer.session_id, status: answer.status }),
          async (error: unknown) => {
            // Final review N1: refused because the path has a started session; enter it.
            const open = isSessionOpen(error) ? openSessionOf((await targets.reload())?.targets ?? null, step.targetId) : null;
            setCreated(open ? { kind: 'open', sessionId: open } : { kind: 'failed' });
          },
        );
        return;
      }
    }
  });

  return (
    <SafeAreaView style={styles.screen} testID="practice-opening">
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={styles.line}>{strings.practiceOpening}</Text>
      <PracticeMoreSheet
        visible={ask === 'asking'}
        onLater={(stop) => {
          if (stop && user) void practiceMoreAsk.stopAsking(user.username);
          leave('home');
        }}
        onAnyway={(stop) => {
          if (stop && user) void practiceMoreAsk.stopAsking(user.username);
          setAsk('go');
        }}
        onCancel={() => leave('home')}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
  },
  line: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
});
