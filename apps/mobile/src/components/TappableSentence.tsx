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
   *  each word's this with `-word-N`, and its Italian, once tapped, `-word-N-text`
   *  (phase 62: the practised word's, once revealed, `-mark-text`). */
  testID: string;
  /** Phase 62 (spec D3). The sentence's own direction: Hebrew right to left (the
   *  default), a target-language sentence left to right, its Hebrew under it right to left. */
  direction?: 'rtl' | 'ltr';
  /** Phase 62 (spec D5). The card's answer is final: every word shows its
   *  translation, the tapped ones still in the colour a tap gave them. */
  reveal?: boolean;
  /** Phase 62 (spec D3). A gap card: the practised word is a blank until revealed. */
  gap?: boolean;
  /** Phase 62 (spec D3). False where the practised word is the question itself (a
   *  gap, a word card's word): it is shown, never tapped. */
  targetTappable?: boolean;
};

/**
 * Phase 59c (design A). A sentence translation's Hebrew, word by word: each word
 * a tap can show is underlined, dotted until it is tapped, and its Italian then
 * appears under it, until the card ends. Each word keeps a line for it from the
 * start, so a tap moves nothing. A tap on the practised word is help (the
 * session's); it is bold, with a solid line.
 *
 * Phase 62 (spec D3, D5). Any sentence a card taps, in its own direction: a gap
 * card's, whose practised word is a blank, and a word card's context line, whose
 * practised word is the question. Once the answer is final every word shows its
 * translation, and none can be tapped.
 */
export function TappableSentence({ text, words, mark, tapped, onTap, hint, style, testID, direction = 'rtl', reveal = false, gap = false, targetTappable = true }: Props) {
  const units = sentenceUnits(text, words, mark);
  // A card with no map shows no Italian, so it keeps no line for it.
  const roomForItalian = words !== null && words !== undefined;
  return (
    <View style={styles.block}>
      <View style={[styles.sentence, { direction }]} testID={testID}>
        {units.map((unit, at) => (
          <Word
            key={at}
            unit={unit}
            tapped={typeof unit.tap === 'number' && tapped.includes(unit.tap)}
            onTap={unit.target && !targetTappable ? null : onTap}
            roomForItalian={roomForItalian}
            style={style}
            testID={testID}
            reveal={reveal}
            blank={gap && unit.target && !reveal}
            translationDirection={direction === 'rtl' ? 'ltr' : 'rtl'}
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
  reveal,
  blank,
  translationDirection,
}: {
  unit: Unit;
  tapped: boolean;
  onTap: Props['onTap'];
  roomForItalian: boolean;
  style: StyleProp<TextStyle>;
  testID: string;
  reveal: boolean;
  blank: boolean;
  translationDirection: 'rtl' | 'ltr';
}) {
  const tap = unit.tap;
  // Phase 62 (spec D3): a gap is a blank, with no line of its own; once revealed,
  // no word is dotted, since none can be tapped.
  const line = tap === null || blank ? null : tapped ? 'tapped' : unit.target ? 'target' : reveal ? null : 'dotted';
  // Phase 62 (spec D5): revealed, every word with a translation shows it.
  const shown = tap !== null && unit.translation !== null && (tapped || reveal);
  const translationStyle = tapped ? styles.italian : unit.target ? styles.revealedTarget : styles.revealed;
  const body = (
    <>
      <View style={styles.wordRow}>
        {unit.before ? <Text style={style}>{unit.before}</Text> : null}
        <View>
          <Text
            style={[style, unit.target && styles.target]}
            testID={tap === null ? undefined : unit.target ? `${testID}-mark` : `${testID}-word-${tap}`}
          >
            {blank ? '_____' : unit.text}
          </Text>
          {line ? <Underline kind={line} /> : null}
        </View>
        {unit.after ? <Text style={style}>{unit.after}</Text> : null}
      </View>
      {roomForItalian ? (
        <Text
          style={[shown ? translationStyle : styles.italian, { writingDirection: translationDirection }]}
          testID={shown ? (unit.target ? `${testID}-mark-text` : `${testID}-word-${tap}-text`) : undefined}
        >
          {shown ? unit.translation : ' '}
        </Text>
      ) : null}
    </>
  );
  if (tap === null || !onTap) return <View style={styles.word}>{body}</View>;
  return (
    <Pressable
      style={styles.word}
      onPress={() => onTap(tap)}
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
  // The other language's words under the word: a tapped one's in the primary
  // colour (its direction is set per sentence).
  italian: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    color: colors.primary,
    fontWeight: '600',
    textAlign: 'center',
  },
  // Phase 62 (spec D5). Revealed once answered: muted, the practised word's in bold.
  revealed: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center' },
  revealedTarget: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.text, fontWeight: '700', textAlign: 'center' },
  hint: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
});
