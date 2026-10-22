import type { TargetSummary } from '@lang-tutor/core/api';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { BandCard, cardButton } from '@/components/BandCard';
import { targetSessionAction, type HomeAction } from '@/nextSession';
import { strings } from '@/strings';
import {
  countdownBig,
  dueDayLabel,
  fuseOf,
  readinessBar,
  readinessColor,
  sessionDots,
  sessionsLine,
  sessionsSpoken,
  targetButtonSolid,
  wordBars,
  targetCardState,
  targetTitle,
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
          <View style={styles.urgency}>
            <Text style={styles.urgencyIcon}>⚠</Text>
            <Text testID={`target-urgency-${id}`} style={styles.urgencyText}>
              {urgency.text}
            </Text>
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
          <Readiness target={target} readiness={card.readiness} />
          <Sessions target={target} />
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

/** Phase 65 (spec D4, D5). The big readiness in its colour with its label beside it, then its
 *  bar: the start of the day pale, the day's gain bright at its end, with the gain's label. */
export function Readiness({ target, readiness }: { target: TargetSummary; readiness: string }) {
  const { id } = target;
  const bar = readinessBar(target);
  const color = readinessColor(target.readiness_pct);
  // A lower day leaves the bar at where it is now; the drop is only in the label.
  const pale = Math.min(bar.start, target.readiness_pct);
  const gain = Math.max(0, bar.gain);
  return (
    <>
      <View testID={`target-readiness-${id}`} accessible accessibilityLabel={readiness} style={styles.hero}>
        <Text testID="target-readiness-big" style={[styles.heroNumber, { color }]}>
          {target.readiness_pct}
          <Text style={styles.heroPercent}>%</Text>
        </Text>
        <View>
          <Text style={styles.heroLabel}>{strings.targetReadinessLabel}</Text>
          <Text style={styles.heroLabel}>{strings.targetReadinessFor(target.kind)}</Text>
        </View>
      </View>
      <Bar
        parts={[
          { share: pale / 100, color: paleOf(color) },
          { share: gain / 100, color },
        ]}
      />
      <Text
        testID="target-readiness-gain"
        style={[styles.gain, bar.gain < 0 ? styles.gainDown : null]}
      >
        {bar.label ?? ' '}
      </Text>
    </>
  );
}

/** The start of the day's colour, softened. */
const paleOf = (hsl: string) => hsl.replace('hsl(', 'hsla(').replace(/\)$/, ', 0.45)');

/** Phase 65 (spec D7). Today as a budget: its words and what is left or why it ended, then a
 *  dot per session (green done, grey to do, dashed when faded, blue bonus). Phase 67b (spec D7):
 *  the line is grey until the day's goal is met, then blue while more practice can raise the
 *  card and green when it cannot or at 100%, with its second part under it. A screen reader reads
 *  the row as one Hebrew sentence (sessionsSpoken) and not the dots, which are drawing only; each
 *  dot's kind is in its testID (`target-session-dot-<kind>`). Phase 71 (spec D4): on the eve the
 *  row counts the words still short, bold, with a bar a word in place of the dots
 *  (`target-word-bar-ready`, `target-word-bar-short`), drawing only too. */
export function Sessions({ target }: { target: TargetSummary }) {
  const { id } = target;
  const line = sessionsLine(target);
  const dots = sessionDots(target);
  const bars = wordBars(target);
  if (!line.text && !line.side && dots.length === 0 && bars.length === 0) return null;
  const met = line.tone === 'more' || line.tone === 'done';
  const tone = TONE_STYLES[line.tone];
  return (
    <View testID={`target-sessions-${id}`} accessible accessibilityLabel={sessionsSpoken(target)} style={styles.sessions}>
      <View style={styles.sessionsLine}>
        <View style={styles.sessionsWords}>
          <Text testID={met ? `target-praise-${id}` : `target-today-${id}`} style={[styles.line, styles.sessionsText, tone]}>
            {line.text}
          </Text>
          {line.sub ? (
            <Text testID={`target-sessions-${id}-sub`} style={[styles.sessionsSub, tone]}>
              {line.sub}
            </Text>
          ) : null}
        </View>
        {line.side ? <Text testID={`target-sessions-${id}-side`} style={met ? styles.sideMet : styles.side}>{line.side}</Text> : null}
      </View>
      <View
        testID="target-sessions"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        style={styles.dots}
      >
        {dots.map((dot, at) => (
          <View key={at} testID={`target-session-dot-${dot}`} style={[styles.dot, DOT_STYLES[dot]]} />
        ))}
        {bars.map((bar, at) =>
          bar.ready ? (
            <View key={at} testID="target-word-bar-ready" style={[styles.wordBar, styles.wordBarReady]} />
          ) : (
            <View key={at} testID="target-word-bar-short" style={styles.wordBar}>
              <View style={[styles.wordBarFill, { flex: bar.pct / 100 }]} />
              <View style={{ flex: 1 - bar.pct / 100 }} />
            </View>
          ),
        )}
      </View>
    </View>
  );
}

/** Phase 67b (spec D7). The line's colour by tone: grey to do, blue more helps, green done.
 *  Phase 71 (spec D4): the eve's words line, grey and bold. */
const TONE_STYLES = {
  plain: { color: '#344054' },
  strong: { color: '#344054', fontWeight: '700' },
  more: { color: colors.primary, fontWeight: '700' },
  done: { color: colors.correct, fontWeight: '700' },
} as const;

const DOT_STYLES = {
  done: { backgroundColor: colors.progress },
  todo: { backgroundColor: '#EAECF0' },
  faded: { height: 4, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#D0D5DD' },
  bonus: { backgroundColor: colors.primary },
} as const;

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
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  heroNumber: { fontSize: 54, lineHeight: 58, fontWeight: '900' },
  heroPercent: { fontSize: 26, fontWeight: '800' },
  heroLabel: { fontSize: fontSizes.md, lineHeight: 19, color: '#475467', fontWeight: '600', writingDirection: 'rtl' },
  gain: { minHeight: 14, fontSize: 11.5, lineHeight: 14, fontWeight: '700', color: colors.correct, textAlign: 'right', writingDirection: 'rtl' },
  gainDown: { color: colors.muted },
  sessions: { gap: spacing.sm },
  sessionsLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 },
  sessionsWords: { flexShrink: 1 },
  sessionsText: { fontSize: fontSizes.sm },
  sessionsSub: { fontSize: 13, lineHeight: 20, writingDirection: 'rtl' },
  side: { fontSize: fontSizes.sm, color: '#344054', fontWeight: '600', writingDirection: 'rtl' },
  sideMet: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  dots: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  dot: { width: 22, height: 7, borderRadius: radii.pill },
  // Phase 71 (spec D4): a word's bar on the eve, filled to its readiness; green and full once ready.
  wordBar: { flexDirection: 'row', width: 30, height: 8, borderRadius: radii.pill, backgroundColor: '#EAECF0', overflow: 'hidden' },
  wordBarReady: { backgroundColor: colors.progress },
  wordBarFill: { backgroundColor: '#84ADFF' },
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
