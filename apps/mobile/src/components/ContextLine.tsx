import type { Context, Mark } from '@lang-tutor/core/api';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { TappableSentence } from '@/components/TappableSentence';
import { markedParts, wholeSentenceOf } from '@/context';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type MarkedTextProps = {
  text: string;
  /** The word to mark; null shows the sentence as it is. */
  mark: Mark | null;
  style: StyleProp<TextStyle>;
  /** The marked word's own `testID` is this one with `-mark` after it. */
  testID: string;
};

/** Phase 34 (spec D6, D8). A sentence with one word in bold: the context
 *  sentence's word, or the practised word in a sentence card's Hebrew. A mark
 *  the sentence cannot hold leaves it unmarked, never cut wrongly. */
export function MarkedText({ text, mark, style, testID }: MarkedTextProps) {
  const parts = markedParts(text, mark);
  return (
    <Text style={style} testID={testID}>
      {parts === null ? (
        text
      ) : (
        <>
          {parts.before}
          <Text style={styles.mark} testID={`${testID}-mark`}>
            {parts.word}
          </Text>
          {parts.after}
        </>
      )}
    </Text>
  );
}

/** Phase 62 (spec D3, D5). What the session knows of a card's taps, for a
 *  sentence it lets the learner tap: the words tapped, the tap, and whether the
 *  answer is final, which reveals every word. `learner` is the language a tap
 *  shows the words in. */
export type SentenceTaps = {
  tapped: readonly number[];
  onTap: (tap: number | 'mark') => void;
  answered: boolean;
  learner: string;
};

type Props = {
  context: Context;
  /** The language the sentence is written in (see contextLanguage): Hebrew
   *  reads right to left, a target language left to right. */
  language: string;
  /** Phase 62: a line with a word map is tapped with these. */
  taps?: SentenceTaps;
};

/** Phase 34 (spec D6). The sentence a card that shows a bare word shows under
 *  it, so the word has one sense, with that word marked. Phase 62 (spec D7):
 *  under a label that names it an example, not the thing to translate. A
 *  target-language line with a word map (spec D3, D5) is full size and tapped
 *  word by word, and once answered shows every word's translation and its own. */
export function ContextLine({ context, language, taps }: Props) {
  const direction = strings.textDirection(language);
  // Spec D5: the whole line's translation once answered, mapped or not.
  const whole = taps ? wholeSentenceOf(context, taps.answered) : null;
  return (
    <View style={styles.block}>
      <Text style={styles.label} testID="context-label">
        {strings.exampleLabel}
      </Text>
      {taps && context.words ? (
        <TappableSentence
          text={context.text}
          words={context.words}
          mark={context.mark}
          tapped={taps.tapped}
          onTap={taps.answered ? null : taps.onTap}
          hint={taps.answered ? null : strings.tapWordHint(taps.learner)}
          style={[styles.tapped, { writingDirection: direction }]}
          testID="context-line"
          direction={direction}
          reveal={taps.answered}
          targetTappable={false}
        />
      ) : (
        <MarkedText text={context.text} mark={context.mark} style={[styles.line, { writingDirection: direction }]} testID="context-line" />
      )}
      {taps && whole ? (
        <View style={styles.whole} testID="context-translation">
          <Text style={styles.label}>{strings.sentenceIn(taps.learner)}</Text>
          <Text style={[styles.wholeText, { writingDirection: strings.textDirection(taps.learner) }]}>{whole}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { alignItems: 'center', gap: spacing.xs },
  label: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
  line: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, textAlign: 'center' },
  // Phase 62 (spec D3): a line to tap reads as text, in the text colour.
  tapped: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.text, textAlign: 'center' },
  whole: { alignItems: 'center', backgroundColor: colors.primarySurface, borderRadius: radii.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginTop: spacing.xs },
  wholeText: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, textAlign: 'center' },
  mark: { fontWeight: '700', color: colors.text },
});
