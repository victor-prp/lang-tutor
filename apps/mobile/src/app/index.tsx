import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { availableTargets } from '@/enrollments';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { usePhotoImports } from '@/hooks/usePhotoImports';
import { useSession } from '@/hooks/useSession';
import { POLL_INTERVAL_MS, homeActionOf, shouldPoll, type HomeAction } from '@/nextSession';
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

export default function HomeScreen() {
  const { enter } = useSession();
  const next = useNextSession();
  const { user, enrollments, active, switchTo } = useCurrentUser();
  const { imports, reload: reloadPhotos } = usePhotoImports();
  // Set by the review after a save (spec D13): "28 words saved".
  const { photoSaved } = useLocalSearchParams<{ photoSaved?: string }>();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // A ref guards re-entry (state is stale between two taps in one frame); the
  // state only drives the disabled look.
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // Fresh on every focus: back from a session, from translate, after a switch.
  // Both reloads change with the active enrollment, so a switch runs this
  // again, and the providers keep each read under the enrollment it was for,
  // so that read is the one shown.
  const { reload } = next;
  useFocusEffect(
    useCallback(() => {
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

  if (!user) return <Redirect href="/login" />;
  // Zero enrollments is a valid state (spec §5): sign-up, a login that finds
  // none, or a sign-up whose second call never landed all arrive here.
  if (!active) return <Redirect href="/enroll" />;

  const canAdd = availableTargets(enrollments).length > 0;
  const action: HomeAction | null = next.current ? homeActionOf(next.current) : null;
  const photoCard = homePhotoCard(imports);

  function enterSession(sessionId: string) {
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

  const create = () =>
    run(async () => {
      const created = await next.create();
      if (created.status === 'ready') enterSession(created.session_id);
    });
  const skip = (sessionId: string) => run(() => next.skip(sessionId));

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={styles.title}>{strings.appTitle}</Text>
        <Text style={styles.subtitle}>{strings.homeSubtitle}</Text>

        <Pressable
          accessibilityRole="button"
          testID="profile-button"
          onPress={() => router.push('/profile')}
          style={styles.profileLink}
        >
          <Text style={styles.profileLinkLabel}>{user.display_name}</Text>
        </Pressable>

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
          onCreate={create}
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

        {/* Deliberately empty. Streak, points and daily-target widgets land here. */}
        <View style={styles.futureSpace} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SessionAction({
  action,
  loadFailed,
  busy,
  onRetry,
  onCreate,
  onEnter,
  onSkip,
}: {
  action: HomeAction | null;
  loadFailed: boolean;
  busy: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onEnter: (sessionId: string) => void;
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
      return primary('start-button', strings.start, onCreate);
    case 'create':
      return primary('create-button', strings.createQuestions, onCreate);
    case 'save-words-first':
      return (
        <Text testID="save-words-first" style={styles.notice}>
          {strings.saveWordsFirst}
        </Text>
      );
    case 'preparing':
      return (
        <>
          <View testID="preparing-label" style={[styles.button, styles.buttonDisabled, styles.preparing]}>
            <ActivityIndicator color={colors.onPrimary} />
            <Text style={styles.buttonLabel}>{strings.preparingQuestions}</Text>
          </View>
          {skip(action.sessionId)}
        </>
      );
    case 'start':
    case 'resume':
      return (
        <>
          {primary('start-button', action.kind === 'start' ? strings.start : strings.resume, () =>
            onEnter(action.sessionId),
          )}
          {skip(action.sessionId)}
        </>
      );
    case 'failed':
      return (
        <>
          <Text testID="preparation-failed" style={styles.notice}>
            {strings.preparationFailed}
          </Text>
          {primary('create-button', strings.createQuestions, onCreate)}
        </>
      );
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  // Phase 26. Scrolls: a preparing session, a photo card and a saved notice
  // together are taller than a small phone, and the last button would be cut off.
  screen: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    lineHeight: lineHeights.xxl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  subtitle: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
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
  profileLink: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  profileLinkLabel: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
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
  futureSpace: { flex: 1 },
});
