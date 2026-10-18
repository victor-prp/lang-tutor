import type { TargetSummary } from '@lang-tutor/core/api';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { BandCard, cardButton } from '@/components/BandCard';
import { targetSessionAction, type HomeAction } from '@/nextSession';
import { strings } from '@/strings';
import {
  countdownBig,
  dueDayLabel,
  fuseOf,
  readinessColor,
  targetButtonSolid,
  targetCardState,
  targetTitle,
  todayBar,
  urgencyOf,
  type TargetCardState,
} from '@/targets';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/**
 * Phase 57 (spec D10, D11), phase 64 (spec D4, D5). A target's card on home: a blue header
 * with its kind, the countdown large ("5 ימים", "מחר", "היום"), its date and the fuse; the
 * "not ready" strip of its last two days; then phase 57's lines: its state's note, today's line
 * and bar, the readiness line and bar, and the button of its own path. Tapping anything above
 * the button opens the target's screen.
 *
 * The card only draws: what the button does is home's (LearningSection), which acts on
 * targetSessionAction(target) as it acts on the main path's action.
 */
export function TargetCard({
  target,
  busy,
  onOpen,
  onPractice,
}: {
  target: TargetSummary;
  /** Another of home's actions is in flight. */
  busy: boolean;
  onOpen: () => void;
  onPractice: () => void;
}) {
  const { id } = target;
  const card = targetCardState(target);
  const big = countdownBig(target.days_left);
  const urgency = urgencyOf(target);
  return (
    <BandCard
      testID={`target-card-${id}`}
      openTestID={`target-row-${id}`}
      onOpen={onOpen}
      icon={target.kind === 'exam' ? 'calendar-outline' : 'document-text-outline'}
      kind={targetTitle(target.kind)}
      big={big.big}
      bigTestID={`target-countdown-${id}`}
      unit={big.unit}
      line={dueDayLabel(target.due_on)}
      fuse={fuseOf(target)}
      fuseTestID={`target-fuse-${id}`}
      strip={
        urgency?.kind === 'not-ready' ? (
          <View testID={`target-urgency-${id}`} style={styles.urgency}>
            <Text style={styles.urgencyIcon}>⚠</Text>
            <Text style={styles.urgencyText}>{urgency.text}</Text>
          </View>
        ) : null
      }
      info={
        <>
          {urgency?.kind === 'ready' ? (
            <Text testID={`target-ready-${id}`} style={styles.ready}>
              {urgency.text}
            </Text>
          ) : null}
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
        </>
      }
      footer={
        /* Final review M3. A target with no word has nothing to practise: no button. */
        card.button !== null ? (
          <PracticeButton
            testID={`target-practice-${id}`}
            action={targetSessionAction(target)}
            label={card.button}
            filled={targetButtonSolid(target)}
            busy={busy}
            onPress={onPractice}
          />
        ) : null
      }
    />
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
  const box = filled ? cardButton.solid : cardButton.pale;
  const text = filled ? cardButton.solidLabel : cardButton.paleLabel;
  if (action.kind === 'preparing') {
    return (
      <Pressable
        accessibilityRole="button"
        testID={testID}
        disabled
        style={[box, cardButton.disabled, styles.preparing]}
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
        style={[box, busy && cardButton.disabled]}
      >
        <Text style={text}>{failed ? strings.translateRetry : label}</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  line: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  extra: { color: colors.correct, fontWeight: '800' },
  ready: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '600', color: colors.correct, writingDirection: 'rtl' },
  urgency: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: 15,
    paddingVertical: 9,
    backgroundColor: colors.amberSurface,
    borderBottomWidth: 1,
    borderBottomColor: '#FEDF89',
  },
  urgencyIcon: { fontSize: 14, lineHeight: 20, color: colors.amber },
  urgencyText: { flex: 1, fontSize: fontSizes.sm, lineHeight: 20, color: colors.amberText, writingDirection: 'rtl' },
  note: { borderRadius: radii.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm },
  noteText: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700', writingDirection: 'rtl' },
  track: {
    flexDirection: 'row',
    height: 7,
    borderRadius: radii.pill,
    backgroundColor: '#EAECF0',
    overflow: 'hidden',
  },
  preparing: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  failed: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
});
