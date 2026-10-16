import type { Mark } from '@lang-tutor/core/api';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { tappableRuns, type ServedWord } from '@/taps';
import { colors } from '@/theme';

type Props = {
  text: string;
  words: readonly ServedWord[] | null | undefined;
  /** The practised word, in bold; the one tappable word on a card with no map. */
  mark: Mark | null;
  /** The words tapped so far, by index; the mark's tap shows nothing of its own. */
  tapped: readonly number[];
  /** Null once the card is answered: the words stay as they were, untappable. */
  onTap: ((tap: number | 'mark') => void) | null;
  style: StyleProp<TextStyle>;
  /** The sentence's `testID`; the practised word's is this with `-mark` after it,
   *  each word's this with `-word-N`, and its Italian, once tapped, `-word-N-text`. */
  testID: string;
};

/**
 * Phase 59 (spec D3). A sentence translation's Hebrew, each word of its map
 * underlined: a tap shows the Italian the answer needs for it, after the word,
 * until the card ends. A tap on the practised word is help (the session's).
 */
export function TappableSentence({ text, words, mark, tapped, onTap, style, testID }: Props) {
  const runs = tappableRuns(text, words, mark);
  return (
    <Text style={style} testID={testID}>
      {runs.map((run, at) => {
        if (run.tap === null) return run.text;
        const shown = typeof run.tap === 'number' && tapped.includes(run.tap) && !run.target;
        const tap = run.tap;
        return (
          <Text key={at}>
            <Text
              style={[styles.word, run.target && styles.mark]}
              onPress={onTap ? () => onTap(tap) : undefined}
              testID={run.target ? `${testID}-mark` : `${testID}-word-${tap}`}
            >
              {run.text}
            </Text>
            {shown ? (
              <Text style={styles.translation} testID={`${testID}-word-${tap}-text`}>
                {` (${run.translation})`}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  word: { textDecorationLine: 'underline', textDecorationColor: colors.muted },
  mark: { fontWeight: '700', color: colors.text },
  translation: { color: colors.primary, writingDirection: 'ltr' },
});
