import type { AnswerVerdict, LetterTilesQuestion } from '@lang-tutor/core/api';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { answerStyles } from '@/components/TypedAnswerView';
import { strings } from '@/strings';
import { builtWord, placeTile, removeTile } from '@/tiles';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  question: LetterTilesQuestion;
  instruction: string;
  answered: boolean;
  verdict: AnswerVerdict | null;
  onSubmit: (text: string) => void;
};

/** Phase 24 (spec D11). The meaning, and the word to build from its letters and
 *  two more. A tap places a tile; a tap on a placed tile returns it. */
export function LetterTilesView({ question, instruction, answered, verdict, onSubmit }: Props) {
  const [placed, setPlaced] = useState<number[]>([]);

  useEffect(() => {
    setPlaced([]);
  }, [question.id]);

  const partOfSpeech = strings.partOfSpeech(question.part_of_speech);
  const built = verdict === null ? null : verdict === 'wrong' ? styles.slotsWrong : styles.slotsCorrect;

  return (
    <View style={styles.container}>
      <Text style={answerStyles.instruction}>{instruction}</Text>
      <Text style={answerStyles.prompt} testID="question-prompt">
        {question.question}
      </Text>
      {partOfSpeech ? (
        <Text style={answerStyles.partOfSpeech} testID="question-part-of-speech">
          {partOfSpeech}
        </Text>
      ) : null}
      <View style={[styles.slots, built]} testID="tiles-built">
        {placed.map((tile, slot) => (
          <Pressable
            key={`slot-${tile}`}
            accessibilityRole="button"
            testID={`tile-slot-${slot}`}
            disabled={answered}
            onPress={() => setPlaced((current) => removeTile(current, slot))}
            style={styles.tile}
          >
            <Text style={styles.letter}>{question.tiles[tile]}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.pool} testID="tiles">
        {question.tiles.map((letter, tile) => {
          const used = placed.includes(tile);
          return (
            <Pressable
              key={`${question.id}-${tile}`}
              accessibilityRole="button"
              testID={`tile-${tile}`}
              disabled={answered || used}
              onPress={() => setPlaced((current) => placeTile(current, tile))}
              style={[styles.tile, used && styles.tileUsed]}
            >
              <Text style={styles.letter}>{letter}</Text>
            </Pressable>
          );
        })}
      </View>
      {answered ? null : (
        <View style={answerStyles.actions}>
          <Pressable
            accessibilityRole="button"
            testID="tiles-submit"
            disabled={placed.length === 0}
            onPress={() => onSubmit(builtWord(question.tiles, placed))}
            style={[answerStyles.check, placed.length === 0 && answerStyles.checkDisabled]}
          >
            <Text style={answerStyles.checkLabel}>{strings.typedCheck}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" testID="tiles-show-answer" hitSlop={8} onPress={() => onSubmit('')}>
            <Text style={answerStyles.showAnswer}>{strings.typedShowAnswer}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const TILE = 44;
const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  // The word being built is the target language: left to right, whatever the screen.
  slots: {
    direction: 'ltr',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: TILE + spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1.5,
    borderColor: colors.border,
  },
  slotsCorrect: { borderColor: colors.correct },
  slotsWrong: { borderColor: colors.wrong },
  pool: { direction: 'ltr', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm },
  tile: {
    minWidth: TILE,
    height: TILE,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileUsed: { opacity: 0.25 },
  letter: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.text },
});
