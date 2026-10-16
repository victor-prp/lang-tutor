import type { TargetSummary } from '@lang-tutor/core/api';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { targetSessionAction, type HomeAction } from '@/nextSession';
import { strings } from '@/strings';
import { readinessColor, targetCardState, todayBar, type TargetCardState } from '@/targets';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Phase 57 (spec D10, D11). A target's card on home: the countdown as its title (option B,
 * the number large in the accent colour), today's line and bar, the readiness line and its
 * bar coloured by the percent, the line of its state (praise, rest, good luck), and the
 * button of its own path. Tapping anything above the button opens the target's screen.
 *
 * The card only draws: what the button does is home's (LearningSection), which acts on
 * targetSessionAction(target) as it acts on the main path's action.
 */
export function TargetCard({
  target,
  filled,
  busy,
  onOpen,
  onPractice,
}: {
  target: TargetSummary;
  /** The first card's button is filled, every other one outlined (homeOrder's `first`). */
  filled: boolean;
  /** Another of home's actions is in flight. */
  busy: boolean;
  onOpen: () => void;
  onPractice: () => void;
}) {
  const { id } = target;
  const card = targetCardState(target);
  const state = target.today.state;
  return (
    <View testID={`target-card-${id}`} style={[styles.card, state !== 'owed' && styles.cardSettled]}>
      <Pressable accessibilityRole="button" testID={`target-row-${id}`} onPress={onOpen} style={styles.info}>
        <Text testID={`target-countdown-${id}`} style={styles.title}>
          {card.title.before}
          {card.title.number !== null ? <Text style={styles.titleNumber}>{card.title.number}</Text> : null}
          {card.title.after}
        </Text>
        {card.note ? <Note id={id} note={card.note} /> : null}
        {card.today ? (
          <>
            <Text testID={`target-today-${id}`} style={styles.line}>
              {card.today.text}
              {card.today.check ? ` ${strings.targetTodayCheck}` : ''}
              {card.today.extra ? <Text style={styles.extra}>{` ${card.today.extra}`}</Text> : null}
            </Text>
            <TodayBar today={target.today} />
          </>
        ) : null}
        <Text testID={`target-readiness-${id}`} style={styles.line}>
          {card.readiness}
        </Text>
        <Bar parts={[{ share: target.readiness_pct / 100, color: readinessColor(target.readiness_pct) }]} />
      </Pressable>
      <PracticeButton
        testID={`target-practice-${id}`}
        action={targetSessionAction(target)}
        label={card.button}
        filled={filled}
        busy={busy}
        onPress={onPractice}
      />
    </View>
  );
}

const NOTE_STYLES = {
  praise: { box: { backgroundColor: colors.correctSurface }, text: { color: colors.correct } },
  rest: { box: { backgroundColor: colors.primarySurface }, text: { color: colors.text } },
  'due-today': { box: { backgroundColor: colors.warmSurface }, text: { color: colors.warmText } },
} as const;

function Note({ id, note }: { id: string; note: NonNullable<TargetCardState['note']> }) {
  const look = NOTE_STYLES[note.kind];
  return (
    <View testID={`target-${note.kind}-${id}`} style={[styles.note, look.box]}>
      <Text style={[styles.noteText, look.text]}>{note.text}</Text>
    </View>
  );
}

/** Today's bar: the planned words done (green once all are), then the extra words in a
 *  lighter green past the plan. */
export function TodayBar({ today }: { today: TargetSummary['today'] }) {
  const shares = todayBar(today);
  return (
    <Bar
      parts={[
        { share: shares.done, color: today.state === 'done' ? colors.correct : colors.primary },
        { share: shares.extra, color: colors.correctLight },
      ]}
    />
  );
}

/** A bar of coloured parts from the start of the line (the right, in RTL), each a share
 *  of the whole; the rest of the track is left empty. */
export function Bar({ parts }: { parts: { share: number; color: string }[] }) {
  const clamped = parts.map((part) => ({ ...part, share: Math.max(0, Math.min(1, part.share)) }));
  const rest = Math.max(0, 1 - clamped.reduce((sum, part) => sum + part.share, 0));
  return (
    <View style={styles.track}>
      {clamped.map((part, at) => (
        <View key={at} style={{ flex: part.share, backgroundColor: part.color }} />
      ))}
      <View style={{ flex: rest }} />
    </View>
  );
}

function PracticeButton({
  testID,
  action,
  label,
  filled,
  busy,
  onPress,
}: {
  testID: string;
  action: HomeAction;
  label: string;
  filled: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const box = filled ? styles.filled : styles.outlined;
  const text = filled ? styles.filledLabel : styles.outlinedLabel;
  if (action.kind === 'preparing') {
    return (
      <Pressable
        accessibilityRole="button"
        testID={testID}
        disabled
        style={[box, styles.disabled, styles.preparing]}
      >
        <ActivityIndicator color={filled ? colors.onPrimary : colors.primary} />
        <Text style={text}>{strings.preparingQuestions}</Text>
      </Pressable>
    );
  }
  const failed = action.kind === 'failed';
  return (
    <>
      {failed ? <Text style={styles.failed}>{strings.preparationFailed}</Text> : null}
      <Pressable
        accessibilityRole="button"
        testID={testID}
        disabled={busy}
        onPress={onPress}
        style={[box, busy && styles.disabled]}
      >
        <Text style={text}>{failed ? strings.translateRetry : label}</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.primary,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardSettled: { borderColor: colors.correct },
  info: { gap: spacing.sm },
  title: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.xl,
    fontWeight: '700',
    color: colors.text,
    writingDirection: 'rtl',
  },
  titleNumber: { fontSize: fontSizes.xl, fontWeight: '800', color: colors.primary },
  line: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  extra: { color: colors.correct, fontWeight: '800' },
  note: { borderRadius: radii.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm },
  noteText: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700', writingDirection: 'rtl' },
  track: {
    flexDirection: 'row',
    height: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  filled: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  outlined: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  filledLabel: { color: colors.onPrimary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
  outlinedLabel: { color: colors.primary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
  disabled: { opacity: 0.6 },
  preparing: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  failed: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
});
