import type { Enrollment } from '@lang-tutor/core/api';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { availableTargets } from '@/enrollments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { usePhotoImports } from '@/hooks/usePhotoImports';
import { useSession } from '@/hooks/useSession';
import { POLL_INTERVAL_MS, createLook, homeActionOf, shouldAutoCreate, shouldPoll, type HomeAction } from '@/nextSession';
import { homePhotoCard, isWorking, type HomePhotoCard } from '@/photoImports';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { strings } from '@/strings';
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
  // Set by the review after a save (spec D13): "28 words saved".
  const { photoSaved } = useLocalSearchParams<{ photoSaved?: string }>();
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

  // Fresh on every focus: back from a session, from translate, after a switch.
  // Both reloads change with the active enrollment, so a switch runs this
  // again, and the providers keep each read under the enrollment it was for,
  // so that read is the one shown.
  const { reload } = next;
  useFocusEffect(
    useCallback(() => {
      attemptedFor.current = null;
      setMakeFailedFor(null);
      reload();
      reloadPhotos();
    }, [reload, reloadPhotos]),
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

  const canAdd = availableTargets(enrollments).length > 0;
  const action: HomeAction | null = next.current ? homeActionOf(next.current) : null;
  const photoCard = homePhotoCard(imports);

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

  // Phase 43 (spec D7). A missing session is made, not offered as a button.
  // After every render: the guard sends it once per focus and enrollment, and
  // waits out another action in flight rather than being swallowed by it.
  useEffect(() => {
    if (inFlight.current || !shouldAutoCreate(action, attemptedFor.current, active.id)) return;
    attemptedFor.current = active.id;
    void makeNext(active.id);
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

      {action?.kind === 'start-seed' ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>
            {strings.homeSetLabel(SESSION_LENGTH, strings.languageName(active.target_language))}
          </Text>
        </View>
      ) : next.current ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>
            {strings.homeSavedLabel(next.current.saved_count, strings.languageName(active.target_language))}
          </Text>
        </View>
      ) : null}

      <SessionAction
        action={action}
        loadFailed={next.loadFailed}
        busy={busy}
        onRetry={reload}
        makeFailed={createLook(makeFailedFor, active.id) === 'retry'}
        onStartSeed={startSeed}
        onMake={() => void makeNext(active.id)}
        onEnter={enterSession}
        onSkip={skip}
      />

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
  const primary = (testID: string, label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      disabled={busy}
      onPress={onPress}
      style={[styles.button, busy && styles.buttonDisabled]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
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
    <View testID="preparing-label" style={[styles.button, styles.buttonDisabled, styles.preparing]}>
      <ActivityIndicator color={colors.onPrimary} />
      <Text style={styles.buttonLabel}>{strings.preparingQuestions}</Text>
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
