import type { ReadAloudQuestion, SayTranslationQuestion } from '@lang-tutor/core/api';
import { rightAnswer } from '@lang-tutor/core/domain';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SpeakButton } from '@/components/SpeakButton';
import { answerStyles } from '@/components/TypedAnswerView';
import type { CardAnswer } from '@/feedback';
import { useRecorder } from '@/hooks/useRecording';
import { MAX_RECORDING_SECONDS, secondsLeft, type Clip } from '@/recording';
import { attemptNotice, type SpeechAttempt } from '@/speaking';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  question: ReadAloudQuestion | SayTranslationQuestion;
  instruction: string;
  /** The enrollment's target language: every word on the card is in it. */
  language: string;
  answer: CardAnswer | null;
  speech: SpeechAttempt;
  onClip: (clip: Clip) => void;
  onRetry: () => void;
  onPass: (kind: 'skip' | 'show_answer') => void;
  onCantSpeak: (reason: 'chosen' | 'no_mic') => void;
};

/**
 * Phase 25 (spec D7). Tap to record, tap to stop; five seconds at most. While
 * the clip is checked the button is disabled. An attempt that was not
 * understood says what was heard, in neutral colours: it is not wrong.
 */
export function SpeakingCardView({ question, instruction, language, answer, speech, onClip, onRetry, onPass, onCantSpeak }: Props) {
  const recorder = useRecorder();
  const [recording, setRecording] = useState(false);
  const [left, setLeft] = useState(MAX_RECORDING_SECONDS);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // A start waits on the permission prompt: a second tap meanwhile is ignored.
  const starting = useRef(false);
  const mounted = useRef(true);
  const answeredRef = useRef(false);
  // The timer's stop reads the latest callback, not the one from when it began.
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const answered = answer !== null;
  answeredRef.current = answered;
  const checking = speech.phase === 'checking';
  const notice = attemptNotice(speech);
  const read = question.type === 'read_aloud';
  const form = rightAnswer(question);

  const clearTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  // Leaving the card mid-recording drops the clip.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      void recorder.cancel();
    };
  }, [recorder]);

  // Answered mid-recording (show the answer): the clip is no longer wanted.
  useEffect(() => {
    if (!answered) return;
    clearTimer();
    setRecording(false);
    void recorder.cancel();
  }, [answered, recorder]);

  async function stop() {
    clearTimer();
    setRecording(false);
    try {
      onClipRef.current(await recorder.stop());
    } catch {
      // Nothing recorded: the button is ready for another try.
    }
  }

  async function onMic() {
    if (answered || checking || starting.current) return;
    if (recording) return stop();
    if (notice) onRetry();
    starting.current = true;
    let started: 'recording' | 'denied';
    try {
      started = await recorder.start();
    } catch {
      // Could not begin: the card stays idle, ready for another try.
      return;
    } finally {
      starting.current = false;
    }
    if (!mounted.current || answeredRef.current) {
      // The card went away, or was answered, while the microphone opened.
      void recorder.cancel();
      return;
    }
    if (started === 'denied') {
      onCantSpeak('no_mic');
      return;
    }
    const startedAt = Date.now();
    setLeft(MAX_RECORDING_SECONDS);
    setRecording(true);
    clearTimer();
    timer.current = setInterval(() => {
      const remaining = secondsLeft(startedAt, Date.now());
      setLeft(remaining);
      if (remaining === 0) void stop();
    }, 250);
  }

  const heard = answer && 'heard' in answer ? answer.heard : null;
  const status = recording ? strings.recordingSecondsLeft(left) : checking ? strings.checking : null;

  return (
    <View style={styles.container}>
      <Text style={answerStyles.instruction}>{instruction}</Text>

      {question.type === 'read_aloud' ? (
        <View style={styles.row}>
          <Text style={styles.form} testID="question-prompt">
            {question.question}
          </Text>
          {/* Spec D2: no speaker before the answer, or reading becomes repeating. */}
          {answered || notice ? <SpeakButton text={form} language={language} testID="speak-form" /> : null}
        </View>
      ) : (
        <>
          <Text style={answerStyles.prompt} testID="question-prompt">
            {question.question}
          </Text>
          {strings.partOfSpeech(question.part_of_speech) ? (
            <Text style={answerStyles.partOfSpeech} testID="question-part-of-speech">
              {strings.partOfSpeech(question.part_of_speech)}
            </Text>
          ) : null}
        </>
      )}

      {answered && question.type === 'read_aloud' ? (
        <Text style={styles.meaning} testID="speak-meaning">
          {question.meaning}
        </Text>
      ) : null}
      {answered && !read ? (
        <View style={styles.row}>
          <Text style={styles.form} testID="speak-answer">
            {form}
          </Text>
          <SpeakButton text={form} language={language} testID="speak-form" />
        </View>
      ) : null}
      {heard !== null && answer && 'heard' in answer && !read ? (
        <Text style={styles.heard} testID="speak-heard">
          {strings.heardLine(heard)}
        </Text>
      ) : null}

      {answered ? null : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.record}
            accessibilityState={{ selected: recording, disabled: checking }}
            aria-selected={recording}
            disabled={checking}
            testID="speak-record"
            onPress={() => void onMic()}
            style={[styles.mic, recording && styles.micOn, checking && styles.micBusy]}
          >
            <Text style={styles.glyph}>🎤</Text>
          </Pressable>
          {status ? (
            <Text style={styles.status} testID="speak-status">
              {status}
            </Text>
          ) : null}

          {notice ? (
            <View style={styles.notice} testID="speak-notice">
              <Text style={styles.noticeTitle}>{notice.title}</Text>
              {notice.heard !== null ? (
                <Text style={styles.form} testID="speak-notice-heard">
                  {notice.heard}
                </Text>
              ) : null}
              <View style={styles.noticeActions}>
                <Pressable accessibilityRole="button" testID="speak-try-again" onPress={onRetry} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{strings.tryAgain}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" testID="speak-continue" onPress={() => onPass('skip')} style={styles.secondary}>
                  <Text style={styles.secondaryLabel}>{strings.continueLabel}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <View style={answerStyles.actions}>
            {read ? null : (
              <Pressable
                accessibilityRole="button"
                testID="speak-show-answer"
                hitSlop={8}
                disabled={checking}
                onPress={() => onPass('show_answer')}
                style={checking && styles.micBusy}
              >
                <Text style={answerStyles.showAnswer}>{strings.typedShowAnswer}</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              testID="speak-cant-speak"
              hitSlop={8}
              disabled={checking}
              onPress={() => onCantSpeak('chosen')}
              style={checking && styles.micBusy}
            >
              <Text style={answerStyles.showAnswer}>{strings.cantSpeak}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const MIC = 96;
const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  // A target-language word: left to right inside the mirrored screen.
  form: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, writingDirection: 'ltr', textAlign: 'center' },
  meaning: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
  heard: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
  mic: {
    alignSelf: 'center',
    width: MIC,
    height: MIC,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micOn: { backgroundColor: colors.primary },
  micBusy: { opacity: 0.4 },
  glyph: { fontSize: fontSizes.xl },
  status: { alignSelf: 'center', fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted },
  notice: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noticeTitle: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, fontWeight: '700', writingDirection: 'rtl' },
  noticeActions: { flexDirection: 'row', gap: spacing.md, justifyContent: 'center' },
  secondary: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.primary },
  secondaryLabel: { color: colors.primary, fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: '700' },
});
