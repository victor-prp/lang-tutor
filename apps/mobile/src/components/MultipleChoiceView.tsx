import type { MatchingQuestion } from '@lang-tutor/core/api';
import type { ChoiceQuestion } from '@lang-tutor/core/domain';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ListenPrompt } from '@/components/ListenPrompt';
import { OptionButton, type OptionVisualState } from '@/components/OptionButton';
import { SpeakButton } from '@/components/SpeakButton';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

type Props = {
  question: Exclude<ChoiceQuestion, MatchingQuestion>;
  /** What the card asks, in the learner's language. */
  instruction: string;
  /** The enrollment's target language. Voice phase: today's card speaks its
   *  prompt in it; a reversed card's prompt is Hebrew and has no speaker. */
  language: string;
  selectedOption: number | null;
  onSelect: (optionIndex: number) => void;
};

// Phase 23. Today's card asks a target word and offers Hebrew meanings; the
// reversed card asks a Hebrew meaning and offers target words. Only the text
// directions differ (spec D10).
export function MultipleChoiceView({ question, instruction, language, selectedOption, onSelect }: Props) {
  const reversed = question.type === 'reverse_choice';
  const listening = question.type === 'listen_choice';
  const partOfSpeech = reversed ? strings.partOfSpeech(question.part_of_speech) : undefined;
  // All four buttons match the tallest, so a wrapped phrase does not leave the
  // set visually ragged. Reset on every new question.
  const [maxHeight, setMaxHeight] = useState(0);

  useEffect(() => {
    setMaxHeight(0);
  }, [question.id]);

  const answered = selectedOption !== null;

  function visualState(index: number): OptionVisualState {
    if (!answered) return 'idle';
    if (index === question.correct_option) return 'correct';
    if (index === selectedOption) return 'wrong';
    return 'dimmed';
  }

  return (
    <View style={styles.container}>
      <Text style={styles.instruction}>{instruction}</Text>
      {listening ? (
        <ListenPrompt questionId={question.id} text={question.question} language={language} answered={answered} />
      ) : (
        <View style={styles.promptRow}>
          <Text style={[styles.prompt, { writingDirection: reversed ? 'rtl' : 'ltr' }]} testID="question-prompt">
            {question.question}
          </Text>
          {reversed ? null : <SpeakButton text={question.question} language={language} testID="speak-prompt" />}
        </View>
      )}
      {partOfSpeech ? (
        <Text style={styles.partOfSpeech} testID="question-part-of-speech">
          {partOfSpeech}
        </Text>
      ) : null}
      <View style={styles.options}>
        {question.options.map((option, index) => (
          <OptionButton
            key={`${question.id}-${index}`}
            testID={`option-${index}`}
            label={option}
            direction={reversed ? 'ltr' : 'rtl'}
            state={visualState(index)}
            disabled={answered}
            minHeight={maxHeight > 0 ? maxHeight : undefined}
            onPress={() => onSelect(index)}
            onMeasure={(height) =>
              setMaxHeight((previous) => (height > previous ? height : previous))
            }
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  instruction: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    writingDirection: 'rtl',
  },
  // The prompt is centred, with an explicit direction (set per card) so a
  // target word reads correctly inside the mirrored screen, punctuation
  // included.
  promptRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  prompt: {
    flexShrink: 1,
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    color: colors.text,
    textAlign: 'center',
  },
  partOfSpeech: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    color: colors.muted,
    textAlign: 'center',
    marginTop: -spacing.md,
  },
  options: { gap: spacing.sm },
});
