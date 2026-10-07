import { StyleSheet, Text } from 'react-native';

import { splitAtGap } from '@/sentence';
import { colors, fontSizes, lineHeights } from '@/theme';

type Props = {
  sentence: string;
  gap: { start: number; end: number };
  /** False: the gap is a blank. True: the word, in bold. */
  filled: boolean;
};

/** Phase 27 (spec D5). The target-language sentence, left to right, with its
 *  gap blank until the card is answered. */
export function SentenceGap({ sentence, gap, filled }: Props) {
  const { before, word, after } = splitAtGap(sentence, gap);
  return (
    <Text style={styles.sentence} testID="sentence-gap">
      {before}
      {filled ? <Text style={styles.word}>{word}</Text> : '_____'}
      {after}
    </Text>
  );
}

const styles = StyleSheet.create({
  sentence: {
    fontSize: fontSizes.xl,
    lineHeight: lineHeights.xl,
    color: colors.text,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
  word: { fontWeight: '700' },
});
