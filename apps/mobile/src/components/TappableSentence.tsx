import type { Mark } from '@lang-tutor/core/api';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { sentenceUnits, type ServedWord, type Unit } from '@/taps';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

type Props = {
  text: string;
  words: readonly ServedWord[] | null | undefined;
  /** The practised word, in bold; the one tappable word on a card with no map. */
  mark: Mark | null;
  /** The words tapped so far, by index; the mark's tap shows nothing of its own. */
  tapped: readonly number[];
  /** Null once the card is answered: the words stay as they were, untappable. */
  onTap: ((tap: number | 'mark') => void) | null;
  /** Under the sentence, while a tap can show a word: what a tap does. */
  hint: string | null;
  /** The Hebrew words' style. */
  style: StyleProp<TextStyle>;
  /** The sentence's `testID`; the practised word's is this with `-mark` after it,
   *  each word's this with `-word-N`, and its Italian, once tapped, `-word-N-text`. */
  testID: string;
};

/**
 * Phase 59c (design A). A sentence translation's Hebrew, word by word: each word
 * a tap can show is underlined, dotted until it is tapped, and its Italian then
 * appears under it, until the card ends. Each word keeps a line for it from the
 * start, so a tap moves nothing. A tap on the practised word is help (the
 * session's); it is bold, with a solid line.
 */
export function TappableSentence({ text, words, mark, tapped, onTap, hint, style, testID }: Props) {
  const units = sentenceUnits(text, words, mark);
  // A card with no map shows no Italian, so it keeps no line for it.
  const roomForItalian = words !== null && words !== undefined;
  return (
    <View style={styles.block}>
      <View style={styles.sentence} testID={testID}>
        {units.map((unit, at) => (
          <Word
            key={at}
            unit={unit}
            tapped={typeof unit.tap === 'number' && tapped.includes(unit.tap)}
            onTap={onTap}
            roomForItalian={roomForItalian}
            style={style}
            testID={testID}
          />
        ))}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function Word({
  unit,
  tapped,
  onTap,
  roomForItalian,
  style,
  testID,
}: {
  unit: Unit;
  tapped: boolean;
  onTap: Props['onTap'];
  roomForItalian: boolean;
  style: StyleProp<TextStyle>;
  testID: string;
}) {
  const tap = unit.tap;
  const line = tap === null ? null : tapped ? 'tapped' : unit.target ? 'target' : 'dotted';
  const body = (
    <>
      <View style={styles.wordRow}>
        {unit.before ? <Text style={style}>{unit.before}</Text> : null}
        <View>
          <Text
            style={[style, unit.target && styles.target]}
            testID={tap === null ? undefined : unit.target ? `${testID}-mark` : `${testID}-word-${tap}`}
          >
            {unit.text}
          </Text>
          {line ? <Underline kind={line} /> : null}
        </View>
        {unit.after ? <Text style={style}>{unit.after}</Text> : null}
      </View>
      {roomForItalian ? (
        <Text style={styles.italian} testID={tapped ? `${testID}-word-${tap}-text` : undefined}>
          {tapped ? unit.translation : ' '}
        </Text>
      ) : null}
    </>
  );
  if (tap === null) return <View style={styles.word}>{body}</View>;
  return (
    <Pressable
      style={styles.word}
      onPress={onTap ? () => onTap(tap) : undefined}
      disabled={!onTap}
      accessibilityRole="button"
      hitSlop={spacing.xs}
    >
      {body}
    </Pressable>
  );
}

/** Android draws a dashed or dotted border only on all four sides, so a dotted
 *  line is the top of a dotted box, the rest of it clipped away. */
function Underline({ kind }: { kind: 'dotted' | 'target' | 'tapped' }) {
  if (kind === 'dotted') {
    return (
      <View style={styles.underline}>
        <View style={styles.dots} />
      </View>
    );
  }
  return <View style={[styles.underline, { backgroundColor: kind === 'tapped' ? colors.primary : colors.text }]} />;
}

const styles = StyleSheet.create({
  block: { alignItems: 'center', gap: spacing.sm },
  sentence: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'flex-start', rowGap: spacing.xs },
  word: { alignItems: 'center', paddingHorizontal: 2 },
  wordRow: { flexDirection: 'row', alignItems: 'flex-start' },
  target: { fontWeight: '700' },
  underline: { height: 2, marginTop: 1, overflow: 'hidden' },
  dots: { height: 6, borderWidth: 2, borderStyle: 'dotted', borderColor: colors.muted, borderRadius: 1 },
  // The Italian, left to right, under its word.
  italian: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    color: colors.primary,
    fontWeight: '600',
    textAlign: 'center',
    writingDirection: 'ltr',
  },
  hint: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
});
