import type { Enrollment, TargetKind } from '@lang-tutor/core/api';
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ImportsReview } from '@/components/ImportsReview';
import { LookupPanel } from '@/components/LookupPanel';
import { confirm } from '@/confirm';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePhotoImports } from '@/hooks/usePhotoImports';
import { useTargets } from '@/hooks/useTargets';
import { TranslationProvider, type LookupCollect } from '@/hooks/useTranslation';
import { strings } from '@/strings';
import {
  MAX_ENTRIES,
  MAX_PHOTOS,
  addRequest,
  canAdvance,
  createRequest,
  dateRequest,
  discardLeftNothing,
  entriesFull,
  holdsEntry,
  holdsPicks,
  initialWizard,
  isFirstStep,
  isLastStep,
  photosFull,
  photosToUpload,
  wizardReducer,
  wizardRouteOf,
  type WizardRoute,
} from '@/targetWizard';
import { doneFailureMessage, dueDateChoices, stepTitle, targetTitle, wizardTitle } from '@/targets';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

const KINDS: readonly TargetKind[] = ['homework', 'exam'];

/** What is in flight, one thing at a time: the photos being picked (and shrunk), sent
 *  (the photo on its way, of how many), a photo's import being discarded, Done, or
 *  leaving (the wizard's imports being discarded). */
type Work =
  | { kind: 'picking' }
  | { kind: 'uploading'; current: number; total: number }
  | { kind: 'removing' }
  | { kind: 'saving' }
  | { kind: 'leaving' }
  | null;

/**
 * Phase 53 (spec D10). A new target, step by step: its kind, photos of the word list,
 * their review, typed words, and the date. A target screen opens the same wizard for its
 * actions, a mode each: add photos (photos and review), add a word, change the date.
 * Nothing is saved until Done, which sends one request.
 */
export default function TargetWizardScreen() {
  const params = useLocalSearchParams<{ mode?: string; targetId?: string }>();
  const { active } = useCurrentUser();
  const route = wizardRouteOf(params);
  if (!active || !route) return <Redirect href="/" />;
  return <Wizard route={route} enrollment={active} />;
}

// Back where the wizard was opened from: home, or the target screen. A wizard opened
// with nothing under it (a reload on the web) goes home.
const leaveScreen = () => (router.canGoBack() ? router.back() : router.replace('/'));

function Wizard({ route, enrollment }: { route: WizardRoute; enrollment: Enrollment }) {
  const api = useApi();
  const { pick, pickMany, upload, discard } = usePhotoImports();
  const { list, reload: reloadTargets } = useTargets();
  const [state, dispatch] = useReducer(wizardReducer, route.mode, initialWizard);
  // The review's own answer: every import settled, and no change of a row in flight.
  const [reviewSettled, setReviewSettled] = useState(false);
  const [work, setWork] = useState<Work>(null);
  const [error, setError] = useState<string | null>(null);
  // One action at a time: the ref guards re-entry (state is stale between two taps in
  // one frame); `work` draws it.
  const acting = useRef(false);
  const leaving = useRef(false);
  // Every import this wizard made and has not discarded, which leaving discards. Kept by
  // the handlers rather than read from a render, so an upload that lands just as Cancel
  // is pressed is not missed.
  const made = useRef<string[]>([]);
  const [readingDates, setReadingDates] = useState(true);

  // The date step offers the days after the learner's today, which the targets list
  // carries (ADR 0013). Read again on opening, so a wizard opened after midnight does
  // not offer today.
  const readDates = useCallback(() => {
    setReadingDates(true);
    void reloadTargets().finally(() => setReadingDates(false));
  }, [reloadTargets]);
  useFocusEffect(
    useCallback(() => {
      readDates();
    }, [readDates]),
  );

  const busy = work !== null;
  const wordDirection = strings.textDirection(enrollment.target_language);
  const meaningDirection = strings.textDirection(enrollment.source_language);
  const thumbnails = useMemo(
    () => state.photos.map((photo) => `data:${photo.mimeType};base64,${photo.base64}`),
    [state.photos],
  );
  // Collect mode (spec D10): a card's button picks its word into the wizard, a dispatch,
  // so "add all" toggling every card in one go lands every one of them.
  const collect = useMemo<LookupCollect>(
    () => ({
      isPicked: (glossId) => holdsEntry(state, glossId),
      toggle: (entry) => dispatch({ type: 'toggle-entry', entry }),
    }),
    [state],
  );

  async function act(doing: NonNullable<Work>, task: () => Promise<void>) {
    if (acting.current || leaving.current) return;
    acting.current = true;
    setWork(doing);
    setError(null);
    try {
      await task();
    } finally {
      acting.current = false;
      setWork(null);
    }
  }

  // Cancel, and back from the first step: the wizard's imports are discarded, then it
  // leaves. Photos or words picked are asked about first, as nothing of them is saved.
  // An upload still on its way discards its own import when it lands (see goOn).
  async function leave() {
    if (leaving.current || work?.kind === 'saving') return;
    if (holdsPicks(state)) {
      const sure = await confirm({
        title: strings.targetLeaveTitle,
        message: strings.targetLeaveMessage,
        confirm: strings.targetLeaveConfirm,
        cancel: strings.back,
      });
      if (!sure) return;
    }
    leaving.current = true;
    setWork({ kind: 'leaving' });
    const imports = made.current.splice(0);
    await Promise.allSettled(imports.map((importId) => discard(importId)));
    leaveScreen();
  }

  function back() {
    if (busy) return;
    if (isFirstStep(state)) {
      void leave();
      return;
    }
    setError(null);
    dispatch({ type: 'back' });
  }

  // Android's back button is the wizard's back, not a way out that loses the picks
  // and leaves the imports behind. (BackHandler is Android's alone, and logs an error
  // on the web.)
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        back();
        return true;
      });
      return () => subscription.remove();
    }, [back]),
  );

  const chooseKind = (kind: TargetKind) => {
    dispatch({ type: 'kind', kind });
    dispatch({ type: 'next' });
  };

  const take = () =>
    act({ kind: 'picking' }, async () => {
      // Shrinking the photo can fail too, which to the learner is the same failure.
      const result = await pick('camera').catch(() => null);
      if (result === null) setError(strings.targetPhotoAddFailed);
      else if (result.kind === 'denied') setError(strings.photoImportDenied);
      else if (result.kind === 'photo') dispatch({ type: 'photos', photos: [result.photo] });
    });

  const choose = () =>
    act({ kind: 'picking' }, async () => {
      const photos = await pickMany().catch(() => null);
      if (photos === null) setError(strings.targetPhotoAddFailed);
      else if (photos.length > 0) dispatch({ type: 'photos', photos });
    });

  // A photo already sent has its import discarded first, so none is left behind; the
  // photo stays when that fails and the import may still be there.
  const removePhoto = (index: number) =>
    act({ kind: 'removing' }, async () => {
      const importId = state.importIds[index];
      if (importId !== undefined) {
        try {
          await discard(importId);
        } catch (failure) {
          if (!discardLeftNothing(failure)) {
            setError(strings.targetPhotoRemoveFailed);
            return;
          }
        }
        made.current = made.current.filter((id) => id !== importId);
      }
      dispatch({ type: 'remove-photo', index });
    });

  // Next on the photos step: each photo not sent yet becomes its own import (ruling
  // R-D9), one after another, each recorded as it lands, so a failure part way keeps
  // the ones sent and Next again sends only the rest. Then the review.
  const goOn = () =>
    act({ kind: 'uploading', current: 0, total: 0 }, async () => {
      const pending = photosToUpload(state);
      let importIds = [...state.importIds];
      for (const [index, photo] of pending.entries()) {
        setWork({ kind: 'uploading', current: index + 1, total: pending.length });
        let importId: string;
        try {
          importId = (await upload(photo)).id;
        } catch {
          // Refused, no network, or no answer within PHOTO_UPLOAD_TIMEOUT_MS.
          setError(strings.photoImportUploadFailed);
          return;
        }
        if (leaving.current) {
          // Cancelled while it was on its way: the wizard is gone, and so is its import.
          void discard(importId).catch(() => undefined);
          return;
        }
        made.current = [...made.current, importId];
        importIds = [...importIds, importId];
        dispatch({ type: 'uploaded', importIds });
      }
      dispatch({ type: 'next' });
    });

  const next = () => {
    if (state.step === 'photos' && photosToUpload(state).length > 0) {
      void goOn();
      return;
    }
    setError(null);
    dispatch({ type: 'next' });
  };

  const done = () =>
    act({ kind: 'saving' }, async () => {
      try {
        if (route.mode === 'create') {
          const target = await api.createTarget(enrollment.id, createRequest(state));
          made.current = [];
          router.replace(`/targets/${target.id}`);
          return;
        }
        if (route.mode === 'change-date') await api.changeTargetDate(route.targetId, dateRequest(state));
        else await api.addTargetWords(route.targetId, addRequest(state));
        made.current = [];
        leaveScreen();
      } catch (failure) {
        setError(doneFailureMessage(failure));
      }
    });

  const last = isLastStep(state);
  const canGo = canAdvance(state, reviewSettled) && !busy;
  const dates = list ? dueDateChoices(list.today) : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          testID="wizard-back"
          onPress={back}
        >
          <Text style={[styles.link, busy && styles.linkDisabled]}>{strings.back}</Text>
        </Pressable>
        <Text style={styles.title}>{wizardTitle(state.mode)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: work?.kind === 'saving' || work?.kind === 'leaving' }}
          disabled={work?.kind === 'saving' || work?.kind === 'leaving'}
          testID="wizard-cancel"
          onPress={() => void leave()}
        >
          <Text style={styles.link}>{strings.cancel}</Text>
        </Pressable>
      </View>

      <Text testID="wizard-step-title" style={styles.stepTitle}>
        {stepTitle(state.step)}
      </Text>

      <View style={styles.body}>
        {state.step === 'kind' ? (
          <View style={styles.kinds}>
            {KINDS.map((kind) => {
              const selected = state.kind === kind;
              return (
                <Pressable
                  key={kind}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  aria-selected={selected}
                  testID={`wizard-kind-${kind}`}
                  onPress={() => chooseKind(kind)}
                  style={[styles.kind, selected && styles.kindSelected]}
                >
                  <Text style={[styles.kindLabel, selected && styles.kindLabelSelected]}>{targetTitle(kind)}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {state.step === 'photos' ? (
          <>
            <Text style={styles.hint}>{strings.targetPhotosHint}</Text>
            <View style={styles.photoButtons}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || photosFull(state) }}
                disabled={busy || photosFull(state)}
                testID="wizard-photo-take"
                onPress={() => void take()}
                style={[styles.button, styles.grow, (busy || photosFull(state)) && styles.buttonDisabled]}
              >
                <Text style={styles.buttonLabel}>{strings.photoImportTake}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || photosFull(state) }}
                disabled={busy || photosFull(state)}
                testID="wizard-photo-choose"
                onPress={() => void choose()}
                style={[styles.secondaryButton, styles.grow, (busy || photosFull(state)) && styles.buttonDisabled]}
              >
                <Text style={styles.secondaryButtonLabel}>{strings.photoImportChoose}</Text>
              </Pressable>
            </View>
            {work?.kind === 'picking' ? (
              <View testID="wizard-photos-busy" style={styles.progress}>
                <ActivityIndicator />
                <Text style={styles.progressLabel}>{strings.targetPhotosPreparing}</Text>
              </View>
            ) : null}
            {work?.kind === 'uploading' && work.total > 0 ? (
              <View testID="wizard-upload-progress" style={styles.progress}>
                <ActivityIndicator />
                <Text style={styles.progressLabel}>{strings.targetUploading(work.current, work.total)}</Text>
              </View>
            ) : null}
            {photosFull(state) ? <Text style={styles.hint}>{strings.targetPhotosFull(MAX_PHOTOS)}</Text> : null}
            <ScrollView contentContainerStyle={styles.thumbs}>
              {thumbnails.map((uri, index) => (
                <View key={index} testID={`wizard-photo-${index}`} style={styles.thumb}>
                  {/* resize: a phone decodes the photo at the thumbnail's size, not at 2048 px. */}
                  <Image source={{ uri }} style={styles.thumbImage} resizeMethod="resize" />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={strings.targetPhotoRemove}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    hitSlop={8}
                    testID={`wizard-photo-remove-${index}`}
                    onPress={() => void removePhoto(index)}
                    style={styles.thumbRemove}
                  >
                    <Text style={styles.thumbRemoveLabel}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          </>
        ) : null}

        {state.step === 'review' ? (
          <>
            <Text style={styles.hint}>{strings.targetReviewHint}</Text>
            <ImportsReview
              key={state.importIds.join(',')}
              importIds={state.importIds}
              wordDirection={wordDirection}
              locked={busy}
              onSettled={setReviewSettled}
            />
          </>
        ) : null}

        {state.step === 'words' ? (
          <>
            <Text style={styles.hint}>{strings.targetWordsHint}</Text>
            {state.entries.length > 0 ? (
              <View style={styles.entries}>
                <Text style={styles.hint}>{strings.targetPickedCount(state.entries.length)}</Text>
                <ScrollView style={styles.entriesScroll} contentContainerStyle={styles.chips} nestedScrollEnabled>
                  {state.entries.map((entry) => (
                    <View key={entry.gloss_id} testID={`wizard-entry-${entry.gloss_id}`} style={styles.chip}>
                      <Text style={[styles.chipForm, { writingDirection: wordDirection }]}>{entry.form}</Text>
                      <Text style={[styles.chipMeaning, { writingDirection: meaningDirection }]}>{entry.meaning}</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={strings.targetEntryRemove}
                        hitSlop={8}
                        testID={`wizard-entry-remove-${entry.gloss_id}`}
                        onPress={() => dispatch({ type: 'toggle-entry', entry })}
                      >
                        <Text style={styles.chipRemove}>✕</Text>
                      </Pressable>
                    </View>
                  ))}
                </ScrollView>
                {entriesFull(state) ? <Text style={styles.hint}>{strings.targetEntriesFull(MAX_ENTRIES)}</Text> : null}
              </View>
            ) : null}
            <TranslationProvider api={api} collect={collect}>
              <LookupPanel />
            </TranslationProvider>
          </>
        ) : null}

        {state.step === 'date' ? (
          dates ? (
            <ScrollView contentContainerStyle={styles.dates}>
              {dates.map((choice) => {
                const selected = state.dueOn === choice.day;
                return (
                  <Pressable
                    key={choice.day}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    aria-selected={selected}
                    testID={`wizard-date-${choice.day}`}
                    onPress={() => dispatch({ type: 'date', dueOn: choice.day })}
                    style={[styles.date, selected && styles.dateSelected]}
                  >
                    <Text style={[styles.dateLabel, selected && styles.dateLabelSelected]}>{choice.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : readingDates ? (
            <ActivityIndicator testID="wizard-dates-loading" />
          ) : (
            <View style={styles.datesFailed}>
              <Text style={styles.error}>{strings.targetDatesLoadFailed}</Text>
              <Pressable accessibilityRole="button" testID="wizard-dates-retry" onPress={readDates}>
                <Text style={styles.link}>{strings.translateRetry}</Text>
              </Pressable>
            </View>
          )
        ) : null}
      </View>

      {error ? (
        <Text testID="wizard-error" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {/* The kind step has none: a kind's button goes on by itself. */}
      {state.step !== 'kind' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canGo }}
          disabled={!canGo}
          testID={last ? 'wizard-done' : 'wizard-next'}
          onPress={last ? () => void done() : next}
          style={[styles.button, styles.footerButton, !canGo && styles.buttonDisabled]}
        >
          {work?.kind === 'saving' ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.buttonLabel}>{last ? strings.targetWizardDone : strings.targetWizardNext}</Text>
          )}
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  title: { flexShrink: 1, fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  linkDisabled: { opacity: 0.4 },
  stepTitle: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  hint: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  body: { flex: 1, gap: spacing.sm },
  kinds: { gap: spacing.md, paddingTop: spacing.md },
  kind: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  kindSelected: { borderColor: colors.primary, borderWidth: 2 },
  kindLabel: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  kindLabelSelected: { color: colors.primary },
  photoButtons: { flexDirection: 'row', gap: spacing.sm },
  grow: { flex: 1 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  progressLabel: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingBottom: spacing.md },
  thumb: {
    width: 96,
    height: 128,
    borderRadius: radii.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbRemove: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbRemoveLabel: { color: colors.onPrimary, fontSize: fontSizes.sm, fontWeight: '700' },
  entries: { gap: spacing.xs },
  entriesScroll: { maxHeight: 132 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  chipForm: { fontSize: fontSizes.md, fontWeight: '700', color: colors.text },
  chipMeaning: { fontSize: fontSizes.sm, color: colors.muted },
  chipRemove: { fontSize: fontSizes.sm, fontWeight: '700', color: colors.primary },
  dates: { gap: spacing.sm, paddingBottom: spacing.md },
  date: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  dateSelected: { borderColor: colors.primary, borderWidth: 2 },
  dateLabel: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  dateLabelSelected: { color: colors.primary, fontWeight: '700' },
  datesFailed: { gap: spacing.sm, alignItems: 'center', paddingTop: spacing.lg },
  error: { color: colors.wrong, fontSize: fontSizes.md, lineHeight: lineHeights.md, writingDirection: 'rtl' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  footerButton: { marginBottom: spacing.md },
  buttonLabel: { color: colors.onPrimary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
  buttonDisabled: { opacity: 0.6 },
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
});
