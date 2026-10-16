import type { CurrentSessionResponse, Enrollment, TargetSummary } from '@lang-tutor/core/api';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { TargetCard } from '@/components/TargetCard';
import { availableTargets } from '@/enrollments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { usePhotoImports } from '@/hooks/usePhotoImports';
import { useSession } from '@/hooks/useSession';
import { useTargets } from '@/hooks/useTargets';
import {
  POLL_INTERVAL_MS,
  createLook,
  homeActionOf,
  homeReminderStartOf,
  myWordsLine,
  shouldAutoCreate,
  shouldPoll,
  targetSessionAction,
  type HomeAction,
} from '@/nextSession';
import { homePhotoCard, isWorking, type HomePhotoCard } from '@/photoImports';
import { strings } from '@/strings';
import { homeOrder, shouldPollTargets } from '@/targets';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

function photoCardLabel(card: NonNullable<HomePhotoCard>): string {
  switch (card.kind) {
    case 'working':
      return strings.homePhotoWorking;
    case 'ready':
      return strings.homePhotoReady(card.count);
    case 'failed':
      return strings.homePhotoFailed;
    case 'several':
      return strings.homePhotoSeveral(card.count);
  }
}

export function LearningSection({ active }: { active: Enrollment }) {
  const { enter } = useSession();
  const next = useNextSession();
  const { enrollments, switchTo } = useCurrentUser();
  const { imports, reload: reloadPhotos } = usePhotoImports();
  const { list: targetList, reload: reloadTargets, create: createTargetSession } = useTargets();
  // Set by the review after a save (spec D13): "28 words saved".
  const { photoSaved, start } = useLocalSearchParams<{ photoSaved?: string; start?: string }>();
  // Phase 52 (spec D8). Home's own route, so the param is cleared here even if
  // another screen has been opened over home since: router.setParams would clear
  // the focused screen's.
  const navigation = useNavigation<{ setParams: (params: { start?: string }) => void }>();
  const focused = useIsFocused();
  const [switcherOpen, setSwitcherOpen] = useState(false);
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
  // read again too, since the first card's path is the one opened, and `targets` is
  // how that read went; the tick re-renders home when it is in.
  const reminderHeld = useRef<{
    read: CurrentSessionResponse | null;
    targets: 'reading' | 'read' | 'failed';
  } | null>(null);
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
      reloadPhotos();
      void reloadTargets();
    }, [reload, reloadPhotos, reloadTargets]),
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

  // The photo card moves while an import is read or looked up, the same way.
  const photosWorking = imports.some((summary) => isWorking(summary.status));
  useFocusEffect(
    useCallback(() => {
      if (!photosWorking) return undefined;
      const timer = setInterval(reloadPhotos, POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    }, [photosWorking, reloadPhotos]),
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

  const canAdd = availableTargets(enrollments).length > 0;
  const action: HomeAction | null = next.current ? homeActionOf(next.current) : null;
  const photoCard = homePhotoCard(imports);
  // Phase 57 (spec D11). One card per path, by priority; the first one's button is filled.
  const targets = targetList?.targets ?? [];
  const { first, order } = homeOrder(targets);

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

  // Phase 57 (spec D1). A target's button acts on its own path's session as the start
  // button acts on the main path's: enter a ready one; otherwise create one with the
  // target's id, which the card then shows preparing (home polls the targets meanwhile).
  // A preparing one is not pressable.
  const practiceTarget = (target: TargetSummary) => {
    const targetAction = targetSessionAction(target);
    switch (targetAction.kind) {
      case 'start':
      case 'resume':
        enterSession(targetAction.sessionId, targetAction.kind === 'start');
        return;
      case 'create':
      case 'failed':
        void run(async () => {
          await createTargetSession(target.id);
        });
        return;
      default:
        return;
    }
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
  // as well, and a target first is entered as its card's button would enter it.
  useEffect(() => {
    if (start !== 'reminder') {
      reminderHandled.current = false;
      reminderHeld.current = null;
      return;
    }
    if (!focused || reminderHandled.current || inFlight.current) return;
    if (reminderHeld.current === null) {
      const held = { read: next.current, targets: 'reading' as 'reading' | 'read' | 'failed' };
      reminderHeld.current = held;
      reload();
      void reloadTargets().then((ok) => {
        if (reminderHeld.current !== held) return;
        held.targets = ok ? 'read' : 'failed';
        setReminderTick((tick) => tick + 1);
      });
    }
    const held = reminderHeld.current;
    const step = homeReminderStartOf(held.targets === 'read' ? targets : held.targets, action, {
      failed: next.loadFailed || createLook(makeFailedFor, active.id) === 'retry',
      read: next.current !== held.read,
    });
    if (step.kind === 'wait') return;
    reminderHandled.current = true;
    navigation.setParams({ start: undefined });
    if (step.kind === 'enter') enterSession(step.sessionId, step.fresh);
  });

  return (
    <>
      <Pressable
        accessibilityRole="button"
        testID="enrollment-switcher"
        onPress={() => setSwitcherOpen((open) => !open)}
        style={styles.switcher}
      >
        <Text style={styles.switcherLabel}>
          {strings.learningLabel(strings.languageName(active.target_language))}
        </Text>
      </Pressable>

      {switcherOpen ? (
        <View style={styles.switcherList}>
          {enrollments.map((enrollment) => (
            <Pressable
              key={enrollment.id}
              accessibilityRole="button"
              accessibilityState={{ selected: enrollment.id === active.id }}
              testID={`enrollment-option-${enrollment.target_language}`}
              onPress={() => {
                switchTo(enrollment.id);
                setSwitcherOpen(false);
              }}
              style={[styles.switcherItem, enrollment.id === active.id && styles.switcherItemActive]}
            >
              <Text style={styles.switcherItemLabel}>
                {strings.languageName(enrollment.target_language)}
              </Text>
            </Pressable>
          ))}
          {canAdd ? (
            <Pressable
              accessibilityRole="button"
              testID="enrollment-add"
              onPress={() => {
                setSwitcherOpen(false);
                router.push('/enroll');
              }}
              style={styles.switcherItem}
            >
              <Text style={styles.switcherAddLabel}>{strings.addLanguage}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {order.map((card) => {
        if (card === 'main') {
          // Phase 57 (spec D11). My words: the main path, with today's machinery as it was.
          return (
            <View
              key="main"
              testID="home-my-words"
              style={[styles.pathCard, first === 'main' && styles.pathCardFirst]}
            >
              <Text style={styles.pathTitle}>{strings.myWords}</Text>
              {next.current ? (
                <Text style={styles.pathLine}>
                  {myWordsLine(next.current, strings.languageName(active.target_language))}
                </Text>
              ) : null}
              <SessionAction
                action={action}
                filled={first === 'main'}
                loadFailed={next.loadFailed}
                busy={busy}
                onRetry={reload}
                makeFailed={createLook(makeFailedFor, active.id) === 'retry'}
                onStartSeed={startSeed}
                onMake={() => void makeNext(active.id)}
                onEnter={enterSession}
                onSkip={skip}
              />
            </View>
          );
        }
        const target = targets.find((candidate) => candidate.id === card);
        return target ? (
          <TargetCard
            key={card}
            target={target}
            filled={first === card}
            busy={busy}
            onOpen={() => router.push(`/targets/${target.id}`)}
            onPractice={() => practiceTarget(target)}
          />
        ) : null;
      })}

      {photoSaved ? (
        <Text testID="home-photo-saved" style={styles.notice}>
          {strings.photoImportSaved(Number(photoSaved))}
        </Text>
      ) : null}

      {photoCard ? (
        <Pressable
          accessibilityRole="button"
          testID="home-photo-card"
          onPress={() =>
            router.push(photoCard.kind === 'several' ? '/photo-imports' : `/photo-imports/${photoCard.id}`)
          }
          style={styles.card}
        >
          <Text style={styles.cardLabel}>{photoCardLabel(photoCard)}</Text>
        </Pressable>
      ) : null}

      {/* Phase 53. Shown once the first read of the targets lands, as the cards are. */}
      {targetList ? (
        <Pressable
          accessibilityRole="button"
          testID="target-new"
          onPress={() => router.push('/targets/new')}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonLabel}>{strings.targetNew}</Text>
        </Pressable>
      ) : null}

      <Pressable
        accessibilityRole="button"
        testID="translate-entry"
        onPress={() => router.push('/translate')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.translateEntry}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="vocabulary-entry"
        onPress={() => router.push('/vocabulary')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.vocabularyEntry}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="photo-import-entry"
        onPress={() => router.push('/photo-imports')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.photoImportEntry}</Text>
      </Pressable>
    </>
  );
}

function SessionAction({
  action,
  filled,
  loadFailed,
  busy,
  onRetry,
  makeFailed,
  onStartSeed,
  onMake,
  onEnter,
  onSkip,
}: {
  action: HomeAction | null;
  /** Phase 57 (spec D11). My words is home's first card: its button is filled, else outlined. */
  filled: boolean;
  loadFailed: boolean;
  busy: boolean;
  onRetry: () => void;
  /** Phase 43 (spec D7). Home's own create for the `create` state failed. */
  makeFailed: boolean;
  onStartSeed: () => void;
  onMake: () => void;
  onEnter: (sessionId: string, fresh: boolean) => void;
  onSkip: (sessionId: string) => void;
}) {
  const box = filled ? styles.button : styles.outlinedButton;
  const text = filled ? styles.buttonLabel : styles.outlinedButtonLabel;
  const primary = (testID: string, label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      disabled={busy}
      onPress={onPress}
      style={[box, busy && styles.buttonDisabled]}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
  const skip = (sessionId: string) => (
    <Pressable
      accessibilityRole="button"
      testID="home-skip"
      disabled={busy}
      onPress={() => onSkip(sessionId)}
      style={styles.secondaryButton}
    >
      <Text style={styles.secondaryButtonLabel}>{strings.skip}</Text>
    </Pressable>
  );
  const preparingLabel = (
    <View testID="preparing-label" style={[box, styles.buttonDisabled, styles.preparing]}>
      <ActivityIndicator color={filled ? colors.onPrimary : colors.primary} />
      <Text style={text}>{strings.preparingQuestions}</Text>
    </View>
  );
  // Phase 43 (spec D7). Making the next session failed: say so and offer
  // "try again", which makes it again; no button names creating questions.
  const retry = (
    <>
      <Text testID="preparation-failed" style={styles.notice}>
        {strings.preparationFailed}
      </Text>
      {primary('home-make-retry', strings.translateRetry, onMake)}
    </>
  );

  if (!action) {
    if (!loadFailed) return <ActivityIndicator testID="home-loading" />;
    return (
      <>
        <Text testID="home-load-failed" style={styles.notice}>
          {strings.homeLoadFailed}
        </Text>
        <Pressable
          accessibilityRole="button"
          testID="home-retry"
          onPress={onRetry}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonLabel}>{strings.translateRetry}</Text>
        </Pressable>
      </>
    );
  }
  switch (action.kind) {
    case 'start-seed':
      return primary('start-button', strings.start, onStartSeed);
    case 'create':
      // Phase 43 (spec D7). Home sends create itself: this is how it looks.
      return makeFailed ? retry : preparingLabel;
    case 'save-words-first':
      return (
        <Text testID="save-words-first" style={styles.notice}>
          {strings.saveWordsFirst}
        </Text>
      );
    case 'preparing':
      return (
        <>
          {preparingLabel}
          {skip(action.sessionId)}
        </>
      );
    case 'start':
    case 'resume':
      return (
        <>
          {primary('start-button', action.kind === 'start' ? strings.start : strings.resume, () =>
            onEnter(action.sessionId, action.kind === 'start'),
          )}
          {skip(action.sessionId)}
        </>
      );
    case 'failed':
      return retry;
  }
}

const styles = StyleSheet.create({
  // Phase 57 (spec D11). My words, a card like a target's: bordered in the accent colour
  // while it is first.
  pathCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  pathCardFirst: { borderColor: colors.primary },
  pathTitle: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  pathLine: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  card: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardLabel: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
    writingDirection: 'rtl',
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  outlinedButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  outlinedButtonLabel: {
    color: colors.primary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  buttonDisabled: { opacity: 0.6 },
  preparing: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  notice: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
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
  switcher: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  switcherLabel: { color: colors.text, fontSize: fontSizes.md, fontWeight: '700', writingDirection: 'rtl' },
  switcherList: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  switcherItem: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  switcherItemActive: { backgroundColor: colors.background },
  switcherItemLabel: { color: colors.text, fontSize: fontSizes.md, writingDirection: 'rtl' },
  switcherAddLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700', writingDirection: 'rtl' },
});
