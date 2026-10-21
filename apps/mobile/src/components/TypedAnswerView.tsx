import type {
  AnswerVerdict,
  ClozeTypedQuestion,
  DictationQuestion,
  LanguageCode,
  PendingRetry,
  SayTranslationQuestion,
  SentenceTranslationQuestion,
  TypedMeaningQuestion,
  TypedTranslationQuestion,
} from '@lang-tutor/core/api';
import { MAX_JUDGED_TEXT, rightAnswer } from '@lang-tutor/core/domain';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { barButton, barNote } from '@/answerBar';
import { ContextLine, type SentenceTaps } from '@/components/ContextLine';
import { HelpButton } from '@/components/HelpButton';
import { ListenPrompt } from '@/components/ListenPrompt';
import { RetryNotice } from '@/components/RetryNotice';
import { contextLanguage } from '@/context';
import { inputTone, type InputTone, type SentenceLine } from '@/explain';
import { retryText } from '@/feedback';
import type { Retype } from '@/retype';
import { strings, type Instruction } from '@/strings';
import { helpText, typedHelpDone, typedHint } from '@/typedHelp';
import { typedSubmit } from '@/typedSubmit';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

/**
 * Answer bar spec D1. The session's screen around a card: `card` in its scroll
 * view, and under it `bar`, a typed card's answer bar, on the keyboard while it
 * is up. A card with nothing typed passes no bar.
 */
export type CardFrame = (card: ReactNode, bar?: ReactNode) => ReactNode;

// The card roots the e2e flows find a card by (phase 27: the two sentence cards).
const ROOT_TEST_IDS: Record<Props['question']['type'], string | undefined> = {
  typed_translation: undefined,
  dictation: undefined,
  say_translation: undefined,
  typed_meaning: 'meaning-card',
  cloze_typed: 'cloze-card',
  sentence_translation: 'translate-card',
};

type Props = {
  question:
    | TypedTranslationQuestion
    | DictationQuestion
    | SayTranslationQuestion
    | TypedMeaningQuestion
    | ClozeTypedQuestion
    | SentenceTranslationQuestion;
  /** Phase 27: what the card shows in place of its prompt line (a gap card's
   *  sentence, a translation card's Hebrew sentence and, once answered, its
   *  reference). */
  prompt?: ReactNode;
  /** What the card asks, naming the language (set in bold): כתבו את המילה באיטלקית. */
  instruction: Instruction;
  /** Phase 39 (spec D7, D8). The language a typed answer must be in: the target's, or the
   *  learner's on a typed meaning. Null when the card is not checked (`scriptGate`): its
   *  own right answer is in another alphabet, or the app knows no script for it. */
  answerLanguage: LanguageCode | null;
  /** The enrollment's target language: a dictation speaks its word in it. */
  language: string;
  /** Whether this card has been answered: the input locks once it has. */
  answered: boolean;
  /** How the answer was judged, for the input's border. Null until answered. */
  verdict: AnswerVerdict | null;
  /** Phase 56 (spec D5): the session knows whether help was pressed, and says so. */
  onSubmit: (text: string) => void;
  /** Phase 27 (spec D13). The answer's language: a target word is left to
   *  right, a Hebrew meaning right to left. */
  direction: 'ltr' | 'rtl';
  /** A judged card's text is with the server: the card is locked until it answers. */
  checking: boolean;
  /** The server could not judge it: the text stays, and retry sends what is in the box. */
  failed: boolean;
  /** Phase 34 (spec D9). Held for a second try: the card says why, and its
   *  input starts again (a translation keeps its first sentence). */
  retry: PendingRetry | null;
  /** Phase 55 (spec D7). Help: each press reveals one more character of the
   *  answer. Phase 56 (spec D5, D6): on every card here, the count the session
   *  keeps for the card. Phase 63 (spec D3): a press reads what is typed, and
   *  `marks` is the text the last press marked; what help gave shows in the input. */
  help?: { presses: number; onPress: (typed: string) => void; marks: { text: string; from: number } | null } | null;
  /** Phase 55 (spec D7). The retype after a wrong or nearly right first answer,
   *  under that answer's banner title: the card asks for the word again. Phase
   *  56 (spec D7): on a typed meaning, dictation, typed gap and typed say too. */
  retype?: Retype | null;
  retypeTitle?: string;
  /** The first character typed in a retype: the right answer hides. */
  onRetypeTyping?: () => void;
  /** A retype checked; never sent. */
  onRetype?: (text: string) => void;
  /** Phase 62 (spec D3). A typed meaning's context line is tapped word by word. */
  taps?: SentenceTaps;
  /** Phase 66b (spec D2). A translation's sentence, checked with its word: one to
   *  fix makes the input orange, unless the word is wrong. */
  sentence?: SentenceLine | null;
  /** Phase 66b (spec D2). What shows under the input once answered: the corrected sentence. */
  below?: ReactNode;
  /** Answer bar spec D1: where the card and its answer bar are drawn. */
  frame: CardFrame;
};

/**
 * Phase 23. The typed card (spec D9): the meaning, its part of speech, and an
 * input for the target word. The phone must neither "fix" a near miss into a
 * right answer nor a right answer into a wrong one, so autocorrect, spellcheck
 * and autocapitalisation are off.
 */
export function TypedAnswerView({
  question,
  instruction,
  answerLanguage,
  language,
  answered,
  verdict,
  onSubmit,
  direction,
  checking,
  failed,
  prompt,
  retry,
  help = null,
  retype = null,
  retypeTitle,
  onRetypeTyping,
  onRetype,
  taps,
  sentence = null,
  below,
  frame,
}: Props) {
  const [text, setText] = useState('');
  // Phase 39 (spec D8): the last send was in the wrong alphabet, or one word
  // for a whole sentence; the text stays.
  const [refused, setRefused] = useState<'wrong_script' | 'word_only' | null>(null);
  // Phase 63 (spec D3): the grey letters and the marks no longer fit on one line,
  // where the input scrolls and they would not: hidden, not misplaced.
  const [overflow, setOverflow] = useState(false);
  const input = useRef<TextInput>(null);
  // Phase 55 (spec D7): the retype open, which unlocks the answered card for
  // the word again; once it ends, the card is answered as any other.
  const retyping = retype !== null && retype.outcome === null;
  const locked = answered && !retyping;
  const attempt = retype?.attempt ?? 0;

  // A new card, or the same card held for its second try, starts its input
  // again (spec D9). Phase 55 (spec D7): so does each attempt of a retype.
  useEffect(() => {
    setText(retryText(question.type, retry));
    setRefused(null);
  }, [question.id, question.type, retry, attempt]);

  // The keyboard went down with the first answer: the second try brings it
  // back, as does each attempt of a retype.
  useEffect(() => {
    if (retry !== null || attempt > 0) input.current?.focus();
  }, [retry, attempt]);

  const partOfSpeech = 'part_of_speech' in question ? strings.partOfSpeech(question.part_of_speech) : undefined;
  const empty = text.trim() === '';
  // Phase 56 (spec D1): what help reveals on this card, and the presses so far
  // (spec D5: the session's count, kept through a second try).
  const hinted = helpText(question) ?? '';
  const presses = help?.presses ?? 0;
  // No help in a retype: it asks for the word just shown. Phase 63 (spec D9):
  // none on a sentence translation, whose words are tapped instead.
  const helps = help !== null && retype === null && hinted !== '' && question.type !== 'sentence_translation';
  // Phase 63 (spec D3): what help gave not yet typed, in grey after the typing,
  // and the marks of the last press while the text is still the one it read.
  const hebrew = question.type === 'typed_meaning';
  const hint = helps && !locked ? typedHint(hinted, text, presses, hebrew) : null;
  const ghost = hint && hint.ghost !== '' ? `${hint.ghost}${hint.more ? '…' : ''}` : '';
  const markFrom = help !== null && helps && !locked && help.marks !== null && help.marks.text === text ? help.marks.from : null;

  function submit(value: string) {
    if (locked) return;
    const outcome = typedSubmit(value, answerLanguage, question.type === 'sentence_translation' ? question.sentence : null);
    if (outcome === 'wrong_script' || outcome === 'word_only') {
      setRefused(outcome);
      return;
    }
    // The keyboard would cover the feedback banner.
    Keyboard.dismiss();
    if (retyping) onRetype?.(value);
    else onSubmit(value);
  }

  // Phase 55 (spec D7): the input is plain while a retype is open.
  // Phase 66b (spec D2): orange for a sentence to fix around a word that is not wrong.
  const border = BORDERS[retyping ? 'idle' : inputTone(verdict, sentence)];

  // Phase 63 (spec D1, D2): the box holds the help button at its right edge,
  // where the keyboard never hides it, and the input; the input's own text
  // lies over a layer drawn behind it with the grey letters and the marks.
  // Answer bar spec D2, D5: on the bar while it is typed, in the card once judged.
  const box = (
    <View style={[styles.box, border]} testID="typed-box">
      {helps && !locked ? (
        <HelpButton testID="typed-help" disabled={checking || typedHelpDone(hinted, text, presses, hebrew)} onPress={() => help?.onPress(text)} />
      ) : null}
      <View style={styles.field}>
        {ghost !== '' || markFrom !== null ? (
          <Text
            // No physical textAlign: native RTL swaps left and right on a Text (and
            // not on a TextInput), web does not; the base direction puts the layer's
            // text where the input's is on both (phase 1's fix, 1fff73e).
            style={[styles.input, styles.layer, { writingDirection: direction }, overflow && styles.hidden]}
            testID="typed-hint"
            onTextLayout={(event) => setOverflow(event.nativeEvent.lines.length > 1)}
          >
            <Text style={styles.under}>{markFrom === null ? text : text.slice(0, markFrom)}</Text>
            {markFrom !== null ? (
              <Text style={styles.marked} testID="typed-marks">
                {text.slice(markFrom)}
              </Text>
            ) : null}
            {ghost !== '' ? (
              <Text style={styles.ghost} testID="typed-ghost">
                {ghost}
              </Text>
            ) : null}
          </Text>
        ) : null}
        <TextInput
          ref={input}
          testID="typed-input"
          value={text}
          onChangeText={(value) => {
            setText(value);
            setRefused(null);
            // Phase 55 (spec D7): the right answer hides at the first character.
            if (retyping && retype.showing && value !== '') onRetypeTyping?.();
          }}
          editable={!locked && !checking}
          // Answer bar spec D5: the answer, once judged, moves into the card and takes no focus.
          autoFocus={!locked}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          // A sentence is longer than a word (spec D6); Return still submits.
          multiline={question.type === 'sentence_translation'}
          maxLength={question.type === 'sentence_translation' ? MAX_JUDGED_TEXT : 100}
          returnKeyType="done"
          submitBehavior="submit"
          onSubmitEditing={() => {
            if (!empty) submit(text);
          }}
          // Phase 63 (final review): the grey letters stand where the placeholder is.
          placeholder={ghost !== '' ? undefined : strings.typedPlaceholder}
          placeholderTextColor={colors.muted}
          style={[styles.input, question.type === 'sentence_translation' && [styles.sentence, !locked && styles.sentenceGrows], { textAlign: direction === 'rtl' ? 'right' : 'left', writingDirection: direction }]}
        />
      </View>
    </View>
  );

  const card = (
    <View style={styles.container} testID={ROOT_TEST_IDS[question.type]}>
      <InstructionText instruction={instruction} />
      {prompt !== undefined ? (
        prompt
      ) : question.type === 'dictation' ? (
        <>
          <ListenPrompt text={question.question} language={language} answered={answered} />
          {answered ? (
            <Text style={answerStyles.partOfSpeech} testID="dictation-meaning">
              {question.meaning}
            </Text>
          ) : null}
        </>
      ) : 'question' in question ? (
        <>
          <Text style={[answerStyles.prompt, question.type === 'typed_meaning' && styles.promptLtr]} testID="question-prompt">
            {question.question}
          </Text>
          {partOfSpeech ? (
            <Text style={answerStyles.partOfSpeech} testID="question-part-of-speech">
              {partOfSpeech}
            </Text>
          ) : null}
          {'context' in question && question.context ? (
            <ContextLine context={question.context} language={contextLanguage(question.type, language)} taps={taps} />
          ) : null}
        </>
      ) : null}
      {retry !== null && !answered ? <RetryNotice retry={retry} type={question.type} /> : null}
      {/* Answer bar spec D3: the retype's right answer is about the question; its
          notice is on the bar. */}
      {retype !== null && retyping && retype.showing ? (
        <View style={styles.retype} testID="retype">
          <Text style={styles.retypeTitle} testID="retype-title">
            {retypeTitle}
          </Text>
          {/* Phase 56 (spec D7): the card's own answer, in its direction (a meaning right to left). */}
          <Text style={[styles.retypeAnswer, { writingDirection: direction }]} testID="retype-answer">
            {rightAnswer(question)}
          </Text>
        </View>
      ) : null}
      {/* Answer bar spec D5: once judged, the answer in its colour, under the question. */}
      {locked ? box : null}
      {locked ? below : null}
      {/* Answer bar spec D3: last, a short scroll down on a tall card. Phase 55
          (spec D7): the retype has no way round it. */}
      {locked || checking || retyping ? null : (
        <Pressable accessibilityRole="button" testID="typed-show-answer" hitSlop={8} onPress={() => submit('')} style={styles.showAnswer}>
          <Text style={answerStyles.showAnswer}>{strings.typedShowAnswer}</Text>
        </Pressable>
      )}
    </View>
  );

  // Answer bar spec D2: what is being typed, on the keyboard. The note line, the
  // box, and the big button.
  const note = barNote({ refused, failed, checking, retypeAttempt: retyping ? attempt : null });
  const button = barButton({ empty, checking, failed, retyping });
  const bar = locked ? null : (
    <View style={[styles.bar, shadows.bar]}>
      {note === 'wrong_script' && answerLanguage !== null ? (
        <View testID="wrong-script">
          <InstructionText instruction={strings.wrongScriptNotice(answerLanguage)} languageTestId="wrong-script-language" style={[styles.note, styles.wrongScript]} />
        </View>
      ) : null}
      {note === 'word_only' ? (
        <Text style={[styles.note, styles.wrongScript]} testID="word-only">
          {strings.wordOnlyNotice}
        </Text>
      ) : null}
      {note === 'failed' ? (
        <Text style={[styles.note, styles.wrongScript]} testID="judge-failed">
          {strings.couldNotCheck}
        </Text>
      ) : null}
      {note === 'retype' || note === 'retype_again' ? (
        <Text style={styles.note} testID="retype-notice">
          {note === 'retype' ? strings.retypeNotice : strings.tryAgain}
        </Text>
      ) : null}
      {box}
      <Pressable
        accessibilityRole="button"
        testID={button.testID}
        disabled={button.disabled}
        onPress={() => submit(text)}
        style={[answerStyles.check, button.disabled && answerStyles.checkDisabled]}
      >
        <Text style={answerStyles.checkLabel}>{BUTTON_LABELS[button.label]}</Text>
      </Pressable>
    </View>
  );

  return frame(card, bar);
}

const BUTTON_LABELS: Record<ReturnType<typeof barButton>['label'], string> = {
  check: strings.typedCheck,
  checking: strings.checking,
  try_again: strings.tryAgain,
};

/** Phase 39 (spec D9). An instruction with the language it names in bold. */
function InstructionText({
  instruction: i,
  languageTestId = 'instruction-language',
  style,
}: {
  instruction: Instruction;
  languageTestId?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[answerStyles.instruction, style]}>
      {i.before}
      <Text style={styles.instructionLanguage} testID={languageTestId}>
        {i.language}
      </Text>
      {i.after}
    </Text>
  );
}

export const answerStyles = StyleSheet.create({
  instruction: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
  prompt: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  partOfSpeech: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    color: colors.muted,
    textAlign: 'center',
    marginTop: -spacing.md,
  },
  actions: { gap: spacing.md, alignItems: 'center' },
  check: {
    alignSelf: 'stretch',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  checkDisabled: { opacity: 0.5 },
  checkLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  showAnswer: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
});

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  instructionLanguage: { fontWeight: '700' },
  // Phase 39 (spec D8): a refusal, in the colour of the app's other errors, not a second instruction.
  wrongScript: { color: colors.wrong },
  // Phase 63 (spec D2). The box the learner answers in: its border, its colour
  // once answered, and the help button at its right edge (the RTL row's first child).
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    // Start, not right: native RTL swaps a physical side, web does not. Start is the
    // button's side, the screen's right, on both.
    paddingStart: 7,
  },
  field: { flex: 1, alignSelf: 'stretch', justifyContent: 'center' },
  // The answer's language decides: a target word left to right, a Hebrew meaning right to left (phase 27 D13).
  // Transparent, so the layer behind it shows; the layer is laid out exactly as it is.
  input: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
    backgroundColor: 'transparent',
  },
  // Phase 63 (spec D3). Behind the input, its text again: the typed part unseen
  // (the input draws it), the marked part on red, then the grey letters.
  layer: { position: 'absolute', top: 0, left: 0, right: 0, pointerEvents: 'none' },
  hidden: { opacity: 0 },
  under: { color: 'transparent' },
  marked: {
    color: colors.wrong,
    backgroundColor: colors.wrongSurface,
    textDecorationLine: 'underline',
    textDecorationColor: colors.wrong,
  },
  ghost: { color: colors.faint },
  // The meaning card asks with a target-language form, which reads left to right.
  promptLtr: { writingDirection: 'ltr' },
  // Answer bar spec D4. A sentence's text is smaller, so three lines fit beside the
  // big button; Android centres a multiline box's text by default.
  sentence: { fontSize: fontSizes.md, lineHeight: lineHeights.md, textAlignVertical: 'top' },
  // While typed it grows from one line to three, then scrolls inside itself.
  sentenceGrows: { maxHeight: 3 * lineHeights.md + 2 * spacing.md },
  // Answer bar spec D2. White and full width on the keyboard: the screen's side
  // padding undone.
  bar: {
    marginHorizontal: -spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.surface,
  },
  // The one line above the input.
  note: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.text, writingDirection: 'rtl' },
  showAnswer: { alignSelf: 'center' },
  inputIdle: { borderColor: colors.border },
  inputCorrect: { borderColor: colors.correct, backgroundColor: colors.correctSurface },
  inputWrong: { borderColor: colors.wrong, backgroundColor: colors.wrongSurface },
  inputFix: { borderColor: colors.amber, backgroundColor: colors.amberSurface },
  // Phase 55 (spec D7). The retype: the first answer's title and the word, as the banner words them.
  retype: { gap: spacing.xs, alignItems: 'center' },
  retypeTitle: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, fontWeight: '700', textAlign: 'center', writingDirection: 'rtl' },
  retypeAnswer: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, fontWeight: '700', textAlign: 'center', writingDirection: 'ltr' },
});

// Phase 66b (spec D2). The input's border by its tone.
const BORDERS: Record<InputTone, StyleProp<ViewStyle>> = {
  idle: styles.inputIdle,
  correct: styles.inputCorrect,
  wrong: styles.inputWrong,
  fix: styles.inputFix,
};
