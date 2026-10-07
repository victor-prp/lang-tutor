import type {
  AnswerVerdict,
  ClozeTypedQuestion,
  DictationQuestion,
  SayTranslationQuestion,
  SentenceTranslationQuestion,
  TypedMeaningQuestion,
  TypedTranslationQuestion,
} from '@lang-tutor/core/api';
import { MAX_JUDGED_TEXT } from '@lang-tutor/core/domain';
import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ListenPrompt } from '@/components/ListenPrompt';
import { strings } from '@/strings';
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
  /** What the card asks, naming the language: כתבו את המילה באיטלקית. */
  instruction: string;
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
};

/**
 * Phase 23. The typed card (spec D9): the meaning, its part of speech, and an
 * input for the target word. The phone must neither "fix" a near miss into a
 * right answer nor a right answer into a wrong one, so autocorrect, spellcheck
 * and autocapitalisation are off.
 */
export function TypedAnswerView({ question, instruction, language, answered, verdict, onSubmit, direction, checking, failed, prompt }: Props) {
  const [text, setText] = useState('');

  useEffect(() => {
    setText('');
  }, [question.id]);

  const partOfSpeech = 'part_of_speech' in question ? strings.partOfSpeech(question.part_of_speech) : undefined;
  const empty = text.trim() === '';

  function submit(value: string) {
    if (answered) return;
    // The keyboard would cover the feedback banner.
    Keyboard.dismiss();
    onSubmit(value);
  }

  const border =
    verdict === null ? styles.inputIdle : verdict === 'wrong' ? styles.inputWrong : styles.inputCorrect;

  return (
    <View style={styles.container} testID={ROOT_TEST_IDS[question.type]}>
      <Text style={answerStyles.instruction}>{instruction}</Text>
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
        </>
      ) : null}
      <TextInput
        testID="typed-input"
        value={text}
        onChangeText={setText}
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
        style={[styles.input, { textAlign: direction === 'rtl' ? 'right' : 'left', writingDirection: direction }, border]}
      />
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
  inputIdle: { borderColor: colors.border },
  inputCorrect: { borderColor: colors.correct, backgroundColor: colors.correctSurface },
  inputWrong: { borderColor: colors.wrong, backgroundColor: colors.wrongSurface },
});
