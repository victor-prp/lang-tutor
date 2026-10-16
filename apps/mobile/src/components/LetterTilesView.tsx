import type { AnswerVerdict, LetterTilesQuestion } from '@lang-tutor/core/api';
import { tileLetters } from '@lang-tutor/core/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { answerStyles } from '@/components/TypedAnswerView';
import { strings } from '@/strings';
import { builtWord, helpTile, isBuilt, tryTile } from '@/tiles';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  question: LetterTilesQuestion;
  instruction: string;
  answered: boolean;
  verdict: AnswerVerdict | null;
  /** Phase 55 (spec D6): `helped` once help was pressed or a wrong tile tapped. */
  onSubmit: (text: string, helped: boolean) => void;
};

/** Phase 24 (spec D11). The meaning, and the word to build from its letters and
 *  two more. Phase 55 (spec D7): a tapped tile is checked at once against the
 *  next letter. Right, it is placed, and placed tiles stay; wrong, it stays in
 *  the pool and the card says so until the next right tile. Help places the
 *  next letter. Either makes the card helped. The card answers itself when its
 *  last letter is placed. */
export function LetterTilesView({ question, instruction, answered, verdict, onSubmit }: Props) {
  const [placed, setPlaced] = useState<number[]>([]);
  const [wrong, setWrong] = useState(false);
  const [helped, setHelped] = useState(false);
  // Answered once, however fast the last taps come.
  const sent = useRef(false);
  const expected = useMemo(() => tileLetters(question.answer) ?? [], [question.answer]);

  useEffect(() => {
    setPlaced([]);
    setWrong(false);
    setHelped(false);
    sent.current = false;
  }, [question.id]);

  const partOfSpeech = strings.partOfSpeech(question.part_of_speech);
  const built = verdict === null ? null : verdict === 'wrong' ? styles.slotsWrong : styles.slotsCorrect;
  const closed = () => answered || sent.current;

  function submit(text: string, wasHelped: boolean) {
    if (closed()) return;
    sent.current = true;
    onSubmit(text, wasHelped);
  }

  function place(next: number[], wasHelped: boolean) {
    setPlaced(next);
    setWrong(false);
    if (isBuilt(next, expected)) submit(builtWord(question.tiles, next), wasHelped);
  }

  function tap(tile: number) {
    if (closed()) return;
    const step = tryTile(placed, tile, question.tiles, expected);
    if (!step.wrong) {
      place(step.placed, helped);
      return;
    }
    setWrong(true);
    setHelped(true);
  }

  function help() {
    if (closed()) return;
    const tile = helpTile(placed, question.tiles, expected);
    if (tile === null) return;
    setHelped(true);
    place([...placed, tile], true);
  }

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
      {/* Placed tiles are the word's right start: they are not taken back. */}
      <View style={[styles.slots, built]} testID="tiles-built">
        {placed.map((tile, slot) => (
          <View key={`slot-${tile}`} testID={`tile-slot-${slot}`} style={styles.tile}>
            <Text style={styles.letter}>{question.tiles[tile]}</Text>
          </View>
        ))}
      </View>
      {wrong && !answered ? (
        <Text style={styles.wrongLine} testID="tiles-wrong">
          {strings.tilesWrong}
        </Text>
      ) : null}
      <View style={styles.pool} testID="tiles">
        {question.tiles.map((letter, tile) => {
          const used = placed.includes(tile);
          return (
            <Pressable
              key={`${question.id}-${tile}`}
              accessibilityRole="button"
              testID={`tile-${tile}`}
              disabled={answered || used}
              onPress={() => tap(tile)}
              style={[styles.tile, used && styles.tileUsed]}
            >
              <Text style={styles.letter}>{letter}</Text>
            </Pressable>
          );
        })}
      </View>
      {answered ? null : (
        <View style={answerStyles.actions}>
          <Pressable accessibilityRole="button" testID="tiles-help" hitSlop={8} onPress={help}>
            <Text style={answerStyles.help}>{strings.help}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" testID="tiles-show-answer" hitSlop={8} onPress={() => submit('', helped)}>
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
  // Phase 55 (spec D7): in the colour of the app's other refusals.
  wrongLine: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.wrong, textAlign: 'center', writingDirection: 'rtl', marginTop: -spacing.sm },
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
