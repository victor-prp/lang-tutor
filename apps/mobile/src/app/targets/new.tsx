import Ionicons from '@expo/vector-icons/Ionicons';
import type { Enrollment } from '@lang-tutor/core/api';
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentProps } from 'react';
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
  discardImports,
  discardLeftNothing,
  entriesFull,
  holdsEntry,
  holdsPicks,
  initialWizard,
  isFirstStep,
  isLastStep,
  photosFull,
  photosToUpload,
  saveHolding,
  wizardReducer,
  wizardRouteOf,
  type Destination,
  type WizardRoute,
} from '@/targetWizard';
import { dateHasCome, daysLeftLabel, doneFailureMessage, dueDateChoices, stepTitle, targetTitle, wizardTitle } from '@/targets';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

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
 * Phase 53 (spec D10), phase 64 (spec D8). The photo flow, from the header's camera: photos
 * of a word list, their review, then what to do with the words: save them to My words, make
 * a new prep (more words, then its date), or add them to a prep already open. A target
 * screen opens the same wizard for its two other actions: add a word, change the date.
 * Nothing is saved until Done; leaving discards the flow's imports (R12).
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
  const { pick, pickMany, upload, discard, saveAll } = usePhotoImports();
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

  // Final review I2. Leaving without Cancel or Back (a reminder's tap, which dismisses to
  // home, the browser's back, an iOS swipe) unmounts the wizard: its imports are discarded all
  // the same, in the background, and an upload on its way discards its own when it lands (goOn
  // reads `leaving`). Reset on every mount, as StrictMode mounts twice. `discard` is read
  // through a ref, so a new one never runs the cleanup while the wizard is open.
  const discardOnLeaving = useRef(discard);
  useEffect(() => {
    discardOnLeaving.current = discard;
  }, [discard]);
  useEffect(() => {
    leaving.current = false;
    return () => {
      leaving.current = true;
      void discardImports(made, discardOnLeaving.current);
    };
  }, []);
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
    await discardImports(made, discard);
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

  const chooseDestination = (destination: Destination) => {
    setError(null);
    dispatch({ type: 'destination', destination });
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

  // Done saves the wizard's imports with the target: saveHolding keeps them out of `made` while
  // it is on its way, so leaving meanwhile discards none of them (final review I2). Left by the
  // time it answers (a reminder's tap), the wizard goes nowhere, and a failure discards what
  // Done did not save.
  const done = () =>
    act({ kind: 'saving' }, async () => {
      try {
        if (route.mode === 'photo') {
          const destination = state.destination;
          if (destination?.kind === 'my-words') {
            // The photos' words saved together, as the review shows them (the first row of each
            // gloss) and as a prep saves them; back on תרגול with its "N מילים נשמרו".
            const { saved_gloss_ids } = await saveHolding(made, () => saveAll(state.importIds));
            if (!leaving.current) router.dismissTo({ pathname: '/', params: { photoSaved: String(saved_gloss_ids.length) } });
            return;
          }
          if (destination?.kind === 'target') {
            const { targetId } = destination;
            await saveHolding(made, () => api.addTargetWords(targetId, addRequest(state)));
            if (!leaving.current) router.replace(`/targets/${targetId}`);
            return;
          }
          await saveHolding(made, () => api.createTarget(enrollment.id, createRequest(state)));
          if (!leaving.current) router.dismissTo('/');
          return;
        }
        const { targetId } = route;
        await saveHolding(made, () =>
          route.mode === 'change-date'
            ? api.changeTargetDate(targetId, dateRequest(state))
            : api.addTargetWords(targetId, addRequest(state)),
        );
        if (!leaving.current) leaveScreen();
      } catch (failure) {
        if (leaving.current) void discardImports(made, discard);
        else setError(doneFailureMessage(failure));
      }
    });

  // Phase 64 (spec D8). The preps a photo's words can join: the active ones whose date has
  // not come (the server refuses a change to one on its date).
  const openTargets = (list?.targets ?? []).filter((target) => !dateHasCome(target));

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
          accessibilityLabel={strings.back}
          testID="wizard-back"
          hitSlop={8}
          onPress={back}
          style={[styles.headerIcon, busy && styles.linkDisabled]}
        >
          <Ionicons name="arrow-forward" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{wizardTitle(state.mode)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: work?.kind === 'saving' || work?.kind === 'leaving' }}
          disabled={work?.kind === 'saving' || work?.kind === 'leaving'}
          accessibilityLabel={strings.cancel}
          testID="wizard-cancel"
          hitSlop={8}
          onPress={() => void leave()}
          style={styles.headerIcon}
        >
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
      </View>

      <Text testID="wizard-step-title" style={styles.stepTitle}>
        {stepTitle(state.step)}
      </Text>

      <View style={styles.body}>
        {state.step === 'choose' ? (
          <ScrollView contentContainerStyle={styles.choices}>
            <View style={styles.group}>
              <ChoiceRow
                testID="wizard-dest-my-words"
                icon="book-outline"
                label={strings.targetChooseMyWords}
                selected={state.destination?.kind === 'my-words'}
                onPress={() => chooseDestination({ kind: 'my-words' })}
              />
              <ChoiceRow
                testID="wizard-dest-exam"
                icon="calendar-outline"
                label={strings.targetChooseNewExam}
                selected={state.destination?.kind === 'new' && state.destination.targetKind === 'exam'}
                onPress={() => chooseDestination({ kind: 'new', targetKind: 'exam' })}
              />
              <ChoiceRow
                testID="wizard-dest-homework"
                icon="document-text-outline"
                label={strings.targetChooseNewHomework}
                selected={state.destination?.kind === 'new' && state.destination.targetKind === 'homework'}
                onPress={() => chooseDestination({ kind: 'new', targetKind: 'homework' })}
              />
            </View>
            {openTargets.length > 0 ? (
              <>
                <Text style={styles.groupTitle}>{strings.targetChooseExisting}</Text>
                <View style={styles.group}>
                  {openTargets.map((target) => (
                    <ChoiceRow
                      key={target.id}
                      testID={`wizard-dest-target-${target.id}`}
                      icon="add"
                      label={`${targetTitle(target.kind)} ${daysLeftLabel(target.days_left)}`}
                      detail={strings.targetWordCount(target.word_count)}
                      selected={state.destination?.kind === 'target' && state.destination.targetId === target.id}
                      onPress={() => chooseDestination({ kind: 'target', targetId: target.id })}
                    />
                  ))}
                </View>
              </>
            ) : null}
          </ScrollView>
        ) : null}

        {state.step === 'photos' ? (
          <>
            <Text style={styles.hint}>{strings.targetPhotosHintAdd}</Text>
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
      {
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
      }
    </SafeAreaView>
  );
}

/** Phase 64 (spec D8). One choice of what to do with the words: a row of a white group with
 *  its icon, its label and, for a prep already open, its word count. */
function ChoiceRow({
  testID,
  icon,
  label,
  detail,
  selected,
  onPress,
}: {
  testID: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      aria-selected={selected}
      testID={testID}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      <View style={styles.choiceIcon}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <View style={styles.choiceText}>
        <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>{label}</Text>
        {detail ? <Text style={styles.hint}>{detail}</Text> : null}
      </View>
      {selected ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  title: { flex: 1, fontSize: fontSizes.lg, fontWeight: '800', color: colors.text, writingDirection: 'rtl' },
  headerIcon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  linkDisabled: { opacity: 0.4 },
  stepTitle: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    fontWeight: '800',
    color: colors.text,
    writingDirection: 'rtl',
  },
  hint: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  body: { flex: 1, gap: spacing.sm },
  choices: { gap: spacing.sm, paddingTop: spacing.xs, paddingBottom: spacing.md },
  group: { backgroundColor: colors.surface, borderRadius: radii.group, overflow: 'hidden', ...shadows.card },
  groupTitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    color: colors.muted,
    marginTop: spacing.sm,
    marginHorizontal: spacing.xs,
    writingDirection: 'rtl',
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  choiceSelected: { backgroundColor: colors.primarySurface },
  choiceIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceText: { flex: 1, gap: 2 },
  choiceLabel: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '600', color: colors.text, writingDirection: 'rtl' },
  choiceLabelSelected: { color: colors.primary },
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
    ...shadows.card,
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
    ...shadows.card,
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
    ...shadows.card,
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
