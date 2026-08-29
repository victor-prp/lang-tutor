import type { MultipleChoiceQuestion } from '@lang-tutor/core/api';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { OptionButton, type OptionVisualState } from '@/components/OptionButton';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

type Props = {
  question: MultipleChoiceQuestion;
  selectedOption: number | null;
  onSelect: (optionIndex: number) => void;
};

export function MultipleChoiceView({ question, selectedOption, onSelect }: Props) {
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
      <Text style={styles.instruction}>{strings.questionInstruction}</Text>
      <Text style={styles.prompt} testID="question-prompt">{question.question}</Text>
      <View style={styles.options}>
        {question.options.map((option, index) => (
          <OptionButton
            key={`${question.id}-${index}`}
            testID={`option-${index}`}
            label={option}
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
  // The English prompt is centred and explicitly LTR so it reads correctly
  // inside the mirrored screen, punctuation included.
  prompt: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
  options: { gap: spacing.sm },
});
