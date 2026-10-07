import type { MatchingQuestion } from '@lang-tutor/core/api';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { firstAttempts, meaningTaken, startBoard, tapMeaning, tapWord, type BoardState } from '@/board';
import { OptionButton, type OptionVisualState } from '@/components/OptionButton';
import { answerStyles } from '@/components/TypedAnswerView';
import { spacing } from '@/theme';

type Props = {
  question: MatchingQuestion;
  instruction: string;
  answered: boolean;
  onComplete: (firstAttempts: number[]) => void;
};

/**
 * Phase 24 (spec D10). Four words and five meanings: a tap on each side pairs
 * them, in either order. A right pair locks; a wrong one flashes until the next
 * tap. When the last word is matched, the board reports each word's first try.
 */
export function MatchingBoardView({ question, instruction, answered, onComplete }: Props) {
  const [state, setState] = useState<BoardState>(() => startBoard(question));
  const reported = useRef<string | null>(null);

  useEffect(() => {
    setState(startBoard(question));
    // A new board, not a re-render of this one: keyed on the id alone.
  }, [question.id]);

  const done = firstAttempts(state);
  useEffect(() => {
    if (!done || answered || reported.current === question.id) return;
    reported.current = question.id;
    onComplete(done);
  }, [done, answered, question.id, onComplete]);

  const wordState = (word: number): OptionVisualState => {
    if (state.matched[word]) return 'correct';
    if (state.miss?.word === word) return 'wrong';
    return state.word === word ? 'selected' : 'idle';
  };
  const meaningState = (meaning: number): OptionVisualState => {
    if (meaningTaken(state, question, meaning)) return 'correct';
    if (state.miss?.meaning === meaning) return 'wrong';
    return state.meaning === meaning ? 'selected' : 'idle';
  };

  return (
    <View style={styles.container} testID="board">
      <Text style={answerStyles.instruction}>{instruction}</Text>
      {/* A row in the mirrored screen: the Hebrew meanings on the right. */}
      <View style={styles.columns}>
        <View style={styles.column}>
          {question.options.map((meaning, index) => (
            <OptionButton
              key={`meaning-${index}`}
              testID={`board-meaning-${index}`}
              label={meaning}
              direction="rtl"
              state={meaningState(index)}
              disabled={answered || meaningTaken(state, question, index)}
              onPress={() => setState((current) => tapMeaning(current, question, index))}
              onMeasure={() => undefined}
            />
          ))}
        </View>
        <View style={styles.column}>
          {question.board.words.map((word, index) => (
            <OptionButton
              key={`word-${index}`}
              testID={`board-word-${index}`}
              label={word}
              direction="ltr"
              state={wordState(index)}
              disabled={answered || state.matched[index]}
              onPress={() => setState((current) => tapWord(current, question, index))}
              onMeasure={() => undefined}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  columns: { flexDirection: 'row', gap: spacing.md },
  column: { flex: 1, gap: spacing.sm },
});
