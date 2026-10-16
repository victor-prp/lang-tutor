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
import { MAX_JUDGED_TEXT } from '@lang-tutor/core/domain';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from 'react-native';

import { ContextLine } from '@/components/ContextLine';
import { ListenPrompt } from '@/components/ListenPrompt';
import { RetryNotice } from '@/components/RetryNotice';
import { contextLanguage } from '@/context';
import { retryText } from '@/feedback';
import type { Retype } from '@/retype';
import { strings, type Instruction } from '@/strings';
import { allRevealed, revealed } from '@/typedHelp';
import { typedSubmit } from '@/typedSubmit';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

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
  /** Phase 55 (spec D6): `helped` once help was pressed on the card, first try or second. */
  onSubmit: (text: string, helped: boolean) => void;
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
   *  answer, in a line apart from the input. A typed translation's only. */
  help?: boolean;
  /** Phase 55 (spec D7). The retype after a wrong or nearly right first answer,
   *  under that answer's banner title: the card asks for the word again. */
  retype?: Retype | null;
  retypeTitle?: string;
  /** The first character typed in a retype: the right answer hides. */
  onRetypeTyping?: () => void;
  /** A retype checked; never sent. */
  onRetype?: (text: string) => void;
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
  help = false,
  retype = null,
  retypeTitle,
  onRetypeTyping,
  onRetype,
}: Props) {
  const [text, setText] = useState('');
  // Phase 39 (spec D8): the last send was in the wrong alphabet, or one word
  // for a whole sentence; the text stays.
  const [refused, setRefused] = useState<'wrong_script' | 'word_only' | null>(null);
  // Phase 55 (spec D7): how many characters help has revealed on this card.
  const [presses, setPresses] = useState(0);
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

  // Help counts for the whole card, its second try included (spec D6).
  useEffect(() => {
    setPresses(0);
  }, [question.id]);

  // The keyboard went down with the first answer: the second try brings it
  // back, as does each attempt of a retype.
  useEffect(() => {
    if (retry !== null || attempt > 0) input.current?.focus();
  }, [retry, attempt]);

  const partOfSpeech = 'part_of_speech' in question ? strings.partOfSpeech(question.part_of_speech) : undefined;
  const empty = text.trim() === '';
  const answer = 'answer' in question ? question.answer : '';
  // No help in a retype: it asks for the word just shown.
  const helps = help && retype === null && answer !== '';

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
    else onSubmit(value, presses > 0);
  }

  // Phase 55 (spec D7): the input is plain while a retype is open.
  const border =
    verdict === null || retyping ? styles.inputIdle : verdict === 'wrong' ? styles.inputWrong : styles.inputCorrect;

  return (
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
            <ContextLine context={question.context} language={contextLanguage(question.type, language)} />
          ) : null}
        </>
      ) : null}
      {retry !== null && !answered ? <RetryNotice retry={retry} type={question.type} /> : null}
      {retype !== null && retyping ? (
        <View style={styles.retype} testID="retype">
          {retype.showing ? (
            <>
              <Text style={styles.retypeTitle} testID="retype-title">
                {retypeTitle}
              </Text>
              <Text style={styles.retypeAnswer} testID="retype-answer">
                {answer}
              </Text>
            </>
          ) : null}
          <Text style={styles.retypeNotice} testID="retype-notice">
            {retype.attempt === 1 ? strings.retypeNotice : strings.tryAgain}
          </Text>
        </View>
      ) : null}
      {helps && presses > 0 ? (
        <Text style={styles.hint} testID="typed-hint">
          {`${revealed(answer, presses)}…`}
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
        autoFocus
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
        placeholder={strings.typedPlaceholder}
        placeholderTextColor={colors.muted}
        style={[styles.input, question.type === 'sentence_translation' && styles.inputMultiline, { textAlign: direction === 'rtl' ? 'right' : 'left', writingDirection: direction }, border]}
      />
      {refused === 'wrong_script' && answerLanguage !== null && !locked ? (
        <View testID="wrong-script">
          <InstructionText instruction={strings.wrongScriptNotice(answerLanguage)} languageTestId="wrong-script-language" style={styles.wrongScript} />
        </View>
      ) : null}
      {refused === 'word_only' && !locked ? (
        <Text style={styles.wrongScript} testID="word-only">
          {strings.wordOnlyNotice}
        </Text>
      ) : null}
      {locked ? null : (
        <View style={answerStyles.actions}>
          <Pressable
            accessibilityRole="button"
            testID="typed-submit"
            disabled={empty || checking}
            onPress={() => submit(text)}
            style={[answerStyles.check, (empty || checking) && answerStyles.checkDisabled]}
          >
            <Text style={answerStyles.checkLabel}>{checking ? strings.checking : strings.typedCheck}</Text>
          </Pressable>
          {/* Phase 55 (spec D7): help reveals; it never changes the input. */}
          {helps && !checking ? (
            <Pressable
              accessibilityRole="button"
              testID="typed-help"
              disabled={allRevealed(answer, presses)}
              hitSlop={8}
              onPress={() => setPresses((count) => count + 1)}
              style={allRevealed(answer, presses) && answerStyles.checkDisabled}
            >
              <Text style={answerStyles.help}>{strings.help}</Text>
            </Pressable>
          ) : null}
          {failed && !checking && !retyping ? (
            <>
              <Text style={answerStyles.showAnswer} testID="judge-failed">
                {strings.couldNotCheck}
              </Text>
              <Pressable accessibilityRole="button" testID="judge-try-again" disabled={empty} hitSlop={8} onPress={() => submit(text)}>
                <Text style={answerStyles.showAnswer}>{strings.tryAgain}</Text>
              </Pressable>
            </>
          ) : null}
          {/* Phase 55 (spec D7): the retype has no way round it. */}
          {checking || retyping ? null : (
            <Pressable accessibilityRole="button" testID="typed-show-answer" hitSlop={8} onPress={() => submit('')}>
              <Text style={answerStyles.showAnswer}>{strings.typedShowAnswer}</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

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
  // Phase 55 (spec D7): the help on the tiles and typed cards.
  help: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.primary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
});

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  instructionLanguage: { fontWeight: '700' },
  // Phase 39 (spec D8): a refusal, in the colour of the app's other errors, not a second instruction.
  wrongScript: { color: colors.wrong },
  // The answer's language decides: a target word left to right, a Hebrew meaning right to left (phase 27 D13).
  input: {
    borderWidth: 1.5,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
  },
  // The meaning card asks with a target-language form, which reads left to right.
  promptLtr: { writingDirection: 'ltr' },
  // A sentence needs room, and Android centres a multiline box's text by default.
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  inputIdle: { borderColor: colors.border },
  inputCorrect: { borderColor: colors.correct, backgroundColor: colors.correctSurface },
  inputWrong: { borderColor: colors.wrong, backgroundColor: colors.wrongSurface },
  // Phase 55 (spec D7). The help's letters are the target word: left to right,
  // centred, so the RTL screen leaves them and their ellipsis in place.
  hint: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.text, textAlign: 'center', writingDirection: 'ltr' },
  // Phase 55 (spec D7). The retype: the first answer's title and the word, as the banner words them.
  retype: { gap: spacing.xs, alignItems: 'center' },
  retypeTitle: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, fontWeight: '700', textAlign: 'center', writingDirection: 'rtl' },
  retypeAnswer: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, fontWeight: '700', textAlign: 'center', writingDirection: 'ltr' },
  retypeNotice: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, textAlign: 'center', writingDirection: 'rtl' },
});
