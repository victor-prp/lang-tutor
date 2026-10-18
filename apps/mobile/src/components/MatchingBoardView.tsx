import type { MatchingQuestion } from '@lang-tutor/core/api';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { boardHelpDone, firstAttempts, helpBoard, helpedWords, meaningTaken, startBoard, tapMeaning, tapWord, type BoardState } from '@/board';
import { HelpButton } from '@/components/HelpButton';
import { OptionButton, type OptionVisualState } from '@/components/OptionButton';
import { answerStyles } from '@/components/TypedAnswerView';
import { useSpeaker } from '@/hooks/useSpeech';
import { strings } from '@/strings';
import { spacing } from '@/theme';

type Props = {
  question: MatchingQuestion;
  instruction: string;
  language: string;
  answered: boolean;
  /** Phase 63 (spec D8): with the words help matched, in the same order. */
  onComplete: (firstAttempts: number[], helped: boolean[]) => void;
};

/**
 * Phase 24 (spec D10). Four words and five meanings: a tap on each side pairs
 * them, in either order. A right pair locks; a wrong one flashes until the next
 * tap. When the last word is matched, the board reports each word's first try.
 * Phase 34 (spec D10): each word shows its part of speech under it.
 */
export function MatchingBoardView({ question, instruction, language, answered, onComplete }: Props) {
  const speaker = useSpeaker();
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
    onComplete(done, helpedWords(state));
  }, [done, answered, question.id, onComplete, state]);

  const wordState = (word: number): OptionVisualState => {
    if (state.helped[word]) return 'helped';
    if (state.matched[word]) return 'correct';
    if (state.miss?.word === word) return 'wrong';
    return state.word === word ? 'selected' : 'idle';
  };
  const meaningState = (meaning: number): OptionVisualState => {
    // Phase 63 (spec D8): a meaning help matched is blue, as its word.
    if (question.board.correct_options.some((correct, word) => correct === meaning && state.helped[word])) return 'helped';
    if (meaningTaken(state, question, meaning)) return 'correct';
    if (state.miss?.meaning === meaning) return 'wrong';
    return state.meaning === meaning ? 'selected' : 'idle';
  };

  return (
    <View style={styles.container} testID="board">
      <Text style={answerStyles.instruction}>{instruction}</Text>
      {/* Phase 63 (spec D2, D8): help at the right edge, just above the columns. */}
      {answered ? null : (
        <View style={styles.helpRow}>
          <HelpButton testID="board-help" disabled={boardHelpDone(state)} onPress={() => setState((current) => helpBoard(current, question))} />
        </View>
      )}
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
              // Phase 34 (spec D10): each word's part of speech, under it.
              note={strings.partOfSpeech(question.board.parts_of_speech[index] ?? '')}
              state={wordState(index)}
              disabled={answered || state.matched[index]}
              onPress={() => {
                // Phase 44 (spec D5, R3): the board's target words speak when tapped.
                void speaker.say(word, language);
                setState((current) => tapWord(current, question, index));
              }}
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
  // The RTL row's first child sits at the right edge; the columns follow close.
  helpRow: { flexDirection: 'row', marginBottom: -spacing.sm },
});
