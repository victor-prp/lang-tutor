import type { DictationQuestion, TypedTranslationQuestion, TypedVerdict } from '@lang-tutor/core/api';
import { useEffect, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ListenPrompt } from '@/components/ListenPrompt';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  question: TypedTranslationQuestion | DictationQuestion;
  /** What the card asks, naming the language: כתבו את המילה באיטלקית. */
  instruction: string;
  /** The enrollment's target language: a dictation speaks its word in it. */
  language: string;
  /** Whether this card has been answered: the input locks once it has. */
  answered: boolean;
  /** How the answer was judged, for the input's border. Null until answered. */
  verdict: TypedVerdict | null;
  onSubmit: (text: string) => void;
};

/**
 * Phase 23. The typed card (spec D9): the meaning, its part of speech, and an
 * input for the target word. The phone must neither "fix" a near miss into a
 * right answer nor a right answer into a wrong one, so autocorrect, spellcheck
 * and autocapitalisation are off.
 */
export function TypedAnswerView({ question, instruction, language, answered, verdict, onSubmit }: Props) {
  const [text, setText] = useState('');

  useEffect(() => {
    setText('');
  }, [question.id]);

  const partOfSpeech =
    question.type === 'typed_translation' ? strings.partOfSpeech(question.part_of_speech) : undefined;
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
    <View style={styles.container}>
      <Text style={answerStyles.instruction}>{instruction}</Text>
      {question.type === 'dictation' ? (
        <>
          <ListenPrompt questionId={question.id} text={question.question} language={language} answered={answered} />
          {answered ? (
            <Text style={answerStyles.partOfSpeech} testID="dictation-meaning">
              {question.meaning}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={answerStyles.prompt} testID="question-prompt">
            {question.question}
          </Text>
          {partOfSpeech ? (
            <Text style={answerStyles.partOfSpeech} testID="question-part-of-speech">
              {partOfSpeech}
            </Text>
          ) : null}
        </>
      )}
      <TextInput
        testID="typed-input"
        value={text}
        onChangeText={setText}
        editable={!answered}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        maxLength={100}
        returnKeyType="done"
        submitBehavior="submit"
        onSubmitEditing={() => {
          if (!empty) submit(text);
        }}
        placeholder={strings.typedPlaceholder}
        placeholderTextColor={colors.muted}
        style={[styles.input, border]}
      />
      {answered ? null : (
        <View style={answerStyles.actions}>
          <Pressable
            accessibilityRole="button"
            testID="typed-submit"
            disabled={empty}
            onPress={() => submit(text)}
            style={[answerStyles.check, empty && answerStyles.checkDisabled]}
          >
            <Text style={answerStyles.checkLabel}>{strings.typedCheck}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" testID="typed-show-answer" hitSlop={8} onPress={() => submit('')}>
            <Text style={answerStyles.showAnswer}>{strings.typedShowAnswer}</Text>
          </Pressable>
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
  // The answer is a target-language word: left to right, whatever the screen.
  input: {
    borderWidth: 1.5,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
    textAlign: 'left',
    writingDirection: 'ltr',
  },
  inputIdle: { borderColor: colors.border },
  inputCorrect: { borderColor: colors.correct, backgroundColor: colors.correctSurface },
  inputWrong: { borderColor: colors.wrong, backgroundColor: colors.wrongSurface },
});
