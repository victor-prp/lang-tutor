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
import { strings, type Instruction } from '@/strings';
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
};

/**
 * Phase 23. The typed card (spec D9): the meaning, its part of speech, and an
 * input for the target word. The phone must neither "fix" a near miss into a
 * right answer nor a right answer into a wrong one, so autocorrect, spellcheck
 * and autocapitalisation are off.
 */
export function TypedAnswerView({ question, instruction, answerLanguage, language, answered, verdict, onSubmit, direction, checking, failed, prompt, retry }: Props) {
  const [text, setText] = useState('');
  // Phase 39 (spec D8): the last send was in the wrong alphabet; the text stays.
  const [wrongScriptShown, setWrongScriptShown] = useState(false);
  const input = useRef<TextInput>(null);

  // A new card, or the same card held for its second try, starts its input
  // again (spec D9).
  useEffect(() => {
    setText(retryText(question.type, retry));
    setWrongScriptShown(false);
  }, [question.id, question.type, retry]);

  // The keyboard went down with the first answer: the second try brings it back.
  useEffect(() => {
    if (retry !== null) input.current?.focus();
  }, [retry]);

  const partOfSpeech = 'part_of_speech' in question ? strings.partOfSpeech(question.part_of_speech) : undefined;
  const empty = text.trim() === '';

  function submit(value: string) {
    if (answered) return;
    if (typedSubmit(value, answerLanguage) === 'wrong_script') {
      setWrongScriptShown(true);
      return;
    }
    // The keyboard would cover the feedback banner.
    Keyboard.dismiss();
    onSubmit(value);
  }

  const border =
    verdict === null ? styles.inputIdle : verdict === 'wrong' ? styles.inputWrong : styles.inputCorrect;

  return (
    <View style={styles.container} testID={ROOT_TEST_IDS[question.type]}>
      <InstructionText instruction={instruction} />
      {prompt !== undefined ? (
        prompt
      ) : question.type === 'dictation' ? (
        <>
          <ListenPrompt questionId={question.id} text={question.question} language={language} answered={answered} />
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
      <TextInput
        ref={input}
        testID="typed-input"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setWrongScriptShown(false);
        }}
        editable={!answered && !checking}
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
      {wrongScriptShown && answerLanguage !== null && !answered ? (
        <View testID="wrong-script">
          <InstructionText instruction={strings.wrongScriptNotice(answerLanguage)} languageTestId="wrong-script-language" style={styles.wrongScript} />
        </View>
      ) : null}
      {answered ? null : (
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
          {failed && !checking ? (
            <>
              <Text style={answerStyles.showAnswer} testID="judge-failed">
                {strings.couldNotCheck}
              </Text>
              <Pressable accessibilityRole="button" testID="judge-try-again" disabled={empty} hitSlop={8} onPress={() => submit(text)}>
                <Text style={answerStyles.showAnswer}>{strings.tryAgain}</Text>
              </Pressable>
            </>
          ) : null}
          {checking ? null : (
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
});
