import type { Target, TargetWord } from '@lang-tutor/core/api';
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/ScreenHeader';
import { Bar, TodayBar } from '@/components/TargetCard';
import { confirm } from '@/confirm';
import { useApi } from '@/hooks/useApi';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import {
  actionFailureMessage,
  dateHasCome,
  dueDayLabel,
  readinessColor,
  readinessName,
  screenGroups,
  targetCardState,
  targetTitle,
  withoutWord,
  wordTodayLine,
} from '@/targets';
import type { WizardMode } from '@/targetWizard';
import { colors, fontSizes, lineHeights, radii, spacing, shadows } from '@/theme';

/**
 * Phase 53 (spec D11). One target: its kind and date, how many of its words are ready,
 * and each word with its readiness in the words of spec D4 and a remove button. Its
 * actions open the wizard in a mode of its own (add photos, add a word, change the
 * date), and end it, with a confirmation. Read again on every focus, so it shows what an
 * action just changed.
 */
export default function TargetScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const { active } = useCurrentUser();
  const [target, setTarget] = useState<Target | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Words with a removal in flight: the ref guards re-entry (state is stale between two
  // taps in one frame), the state draws them disabled.
  const removing = useRef(new Set<string>());
  const [removals, setRemovals] = useState<ReadonlySet<string>>(new Set());
  // Words whose skills are open: several at once, each toggled by tapping its row.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (glossId: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (!next.delete(glossId)) next.add(glossId);
      return next;
    });
  const ending = useRef(false);
  const [endBusy, setEndBusy] = useState(false);
  // Reads are numbered as they start: an answer is shown unless a newer one already has
  // been, so a read started before a removal never brings the word back after it.
  const started = useRef(0);
  const applied = useRef(0);

  const load = useCallback(async () => {
    const mine = ++started.current;
    try {
      const read = await api.getTarget(id);
      if (mine < applied.current) return;
      applied.current = mine;
      setTarget(read);
      setLoadFailed(false);
    } catch {
      if (mine < applied.current) return;
      setLoadFailed(true);
    }
  }, [api, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!active) return <Redirect href="/" />;
  const wordDirection = strings.textDirection(active.target_language);
  const meaningDirection = strings.textDirection(active.source_language);

  const mark = (glossId: string, on: boolean) => {
    if (on) removing.current.add(glossId);
    else removing.current.delete(glossId);
    setRemovals(new Set(removing.current));
  };

  // The word goes at once, and the target is read again for its counts. No question
  // asked: the word stays saved, and can be added again.
  const remove = async (glossId: string) => {
    if (removing.current.has(glossId)) return;
    mark(glossId, true);
    setError(null);
    try {
      await api.removeTargetWord(id, glossId);
      setTarget((current) => current && withoutWord(current, glossId));
    } catch (failure) {
      setError(actionFailureMessage(failure));
    } finally {
      mark(glossId, false);
      void load();
    }
  };

  const end = async () => {
    if (ending.current) return;
    ending.current = true;
    const sure = await confirm({
      title: strings.targetEndTitle,
      message: strings.targetEndMessage,
      confirm: strings.targetEndConfirm,
      cancel: strings.back,
    });
    if (!sure) {
      ending.current = false;
      return;
    }
    setEndBusy(true);
    setError(null);
    try {
      await api.endTarget(id);
      // Home, which reads its targets again on focus and no longer lists this one.
      router.dismissTo('/');
    } catch (failure) {
      ending.current = false;
      setEndBusy(false);
      setError(actionFailureMessage(failure));
    }
  };

  const openWizard = (mode: Exclude<WizardMode, 'create'>) =>
    router.push({ pathname: '/targets/new', params: { mode, targetId: id } });

  // A target whose date has come is closed (the server refuses every change), so it
  // offers none.
  const open = target !== null && !dateHasCome(target);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScreenHeader
        title={target ? targetTitle(target.kind) : ''}
        titleTestID={target ? 'target-title' : undefined}
        onBack={() => router.back()}
        backTestID="target-back"
      />

      {!target ? (
        loadFailed ? (
          <View style={styles.failed}>
            <Text testID="target-load-failed" style={styles.notice}>
              {strings.targetLoadFailed}
            </Text>
            <Pressable accessibilityRole="button" testID="target-retry" onPress={() => void load()}>
              <Text style={styles.link}>{strings.translateRetry}</Text>
            </Pressable>
          </View>
        ) : (
          <ActivityIndicator testID="target-loading" />
        )
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Summary target={target} />

          {open ? (
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                testID="target-add-word"
                onPress={() => openWizard('add-words')}
                style={styles.action}
              >
                <Text style={styles.actionLabel}>{strings.targetAddWord}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                testID="target-change-date"
                onPress={() => openWizard('change-date')}
                style={styles.action}
              >
                <Text style={styles.actionLabel}>{strings.targetChangeDate}</Text>
              </Pressable>
            </View>
          ) : null}

          {error ? (
            <Text testID="target-error" style={styles.error}>
              {error}
            </Text>
          ) : null}

          {target.words.length === 0 ? (
            <Text testID="target-empty" style={styles.notice}>
              {strings.targetEmpty}
            </Text>
          ) : null}
          {screenGroups(target).map((group) => (
            <View key={group.key} testID={`target-group-${group.key}`} style={styles.group}>
              {group.title !== null ? <Text style={styles.groupTitle}>{group.title}</Text> : null}
              {group.words.map((word) => {
                const busy = removals.has(word.gloss_id);
                const line = group.lines ? wordTodayLine(word) : null;
                const showing = opened.has(word.gloss_id);
                return (
                  <View key={word.gloss_id} style={styles.wordBox}>
                    <View testID={`target-word-${word.gloss_id}`} style={styles.word}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: showing }}
                        testID={`target-word-toggle-${word.gloss_id}`}
                        onPress={() => toggle(word.gloss_id)}
                        style={styles.wordText}
                      >
                        <Text style={[styles.form, { writingDirection: wordDirection }]}>{word.form}</Text>
                        <Text style={[styles.meaning, { writingDirection: meaningDirection }]}>{word.meaning}</Text>
                        {line ? (
                          <Text testID={`target-word-today-${word.gloss_id}`} style={styles.todayLine}>
                            {line}
                          </Text>
                        ) : null}
                      </Pressable>
                      <Text
                        testID="target-word-readiness"
                        style={[styles.readiness, { color: readinessColor(word.readiness_pct) }]}
                      >
                        {readinessName(word.readiness_pct)}
                      </Text>
                      {open ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ disabled: busy }}
                          disabled={busy}
                          hitSlop={8}
                          testID={`target-word-remove-${word.gloss_id}`}
                          onPress={() => void remove(word.gloss_id)}
                          style={busy && styles.disabled}
                        >
                          <Text style={styles.remove}>{strings.targetWordRemove}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {showing ? <Skills word={word} /> : null}
                  </View>
                );
              })}
            </View>
          ))}

          {open ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: endBusy }}
              disabled={endBusy}
              testID="target-end"
              onPress={() => void end()}
              style={[styles.end, endBusy && styles.disabled]}
            >
              <Text style={styles.endLabel}>{strings.targetEnd}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/** The header, as home's card draws a target: the countdown, the date, today's line and
 *  bar, and the readiness line with its bar. */
function Summary({ target }: { target: Target }) {
  const card = targetCardState(target);
  return (
    <View style={styles.summary}>
      <Text testID="target-countdown" style={styles.countdown}>
        {card.title.before}
        {card.title.number !== null ? <Text style={styles.countdownNumber}>{card.title.number}</Text> : null}
        {card.title.after}
      </Text>
      <Text testID="target-due" style={styles.due}>
        {dueDayLabel(target.due_on)}
      </Text>
      {card.today ? (
        <>
          <Text testID="target-today" style={styles.when}>
            {card.today.text}
            {card.today.check ? ` ${strings.targetTodayCheck}` : ''}
            {card.today.extra ? <Text style={styles.extra}>{` ${card.today.extra}`}</Text> : null}
          </Text>
          <TodayBar today={target.today} />
        </>
      ) : null}
      <Text testID="target-readiness" style={styles.when}>
        {card.readiness}
      </Text>
      <Bar parts={[{ share: target.readiness_pct / 100, color: readinessColor(target.readiness_pct) }]} />
    </View>
  );
}

/** A tapped word's counted skills: a bar out of 100 filled to its chance, green from 90, and
 *  the skill's name. Phase 65 (spec D6): the panel's look is redrawn in Task 7. */
function Skills({ word }: { word: TargetWord }) {
  return (
    <View testID={`target-word-skills-${word.gloss_id}`} style={styles.skills}>
      {word.skills.map((skill) => (
        <View key={skill.dimension} style={styles.skill}>
          <Text style={styles.skillName}>{strings.dimensionName(skill.dimension)}</Text>
          <View style={styles.skillTrack}>
            <View
              style={{
                width: `${skill.chance}%`,
                backgroundColor: skill.chance >= 90 ? colors.correct : colors.primary,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  countdown: { fontSize: fontSizes.lg, lineHeight: lineHeights.xl, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  countdownNumber: { fontSize: fontSizes.xl, fontWeight: '800', color: colors.primary },
  extra: { color: colors.correct, fontWeight: '800' },
  group: { gap: spacing.sm },
  groupTitle: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700', color: colors.muted, writingDirection: 'rtl', marginTop: spacing.sm },
  wordBox: { gap: spacing.xs },
  todayLine: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  skills: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    ...shadows.card,
    padding: spacing.md,
    gap: spacing.sm,
  },
  skill: { gap: spacing.xs },
  skillName: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.text, writingDirection: 'rtl' },
  skillTrack: { flexDirection: 'row', height: 8, borderRadius: radii.pill, backgroundColor: colors.border, overflow: 'hidden' },
  screen: { flex: 1, paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  failed: { gap: spacing.sm, alignItems: 'center', paddingTop: spacing.xl },
  content: { gap: spacing.sm, paddingBottom: spacing.xl },
  summary: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    ...shadows.card,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  due: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  when: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  ready: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700', color: colors.primary, writingDirection: 'rtl' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  action: {
    flexGrow: 1,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    ...shadows.card,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  actionLabel: { color: colors.primary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
  error: { color: colors.wrong, fontSize: fontSizes.md, lineHeight: lineHeights.md, writingDirection: 'rtl' },
  notice: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
  word: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    ...shadows.card,
    padding: spacing.md,
  },
  wordText: { flex: 1, gap: spacing.xs },
  form: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '700', color: colors.text },
  meaning: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted },
  readiness: {
    fontSize: fontSizes.sm,
    fontWeight: '700',
    borderRadius: radii.pill,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    overflow: 'hidden',
    writingDirection: 'rtl',
  },
  remove: { color: colors.wrong, fontSize: fontSizes.sm, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  end: { paddingVertical: spacing.md, alignItems: 'center', marginTop: spacing.md },
  endLabel: { color: colors.wrong, fontSize: fontSizes.md, fontWeight: '700' },
});


