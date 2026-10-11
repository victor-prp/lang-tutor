import type { Context, Mark } from '@lang-tutor/core/api';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { markedParts } from '@/context';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights } from '@/theme';

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

type Props = {
  context: Context;
  /** The language the sentence is written in (see contextLanguage): Hebrew
   *  reads right to left, a target language left to right. */
  language: string;
};

/** Phase 34 (spec D6). The sentence a card that shows a bare word shows under
 *  it, so the word has one sense, with that word marked. */
export function ContextLine({ context, language }: Props) {
  return (
    <MarkedText
      text={context.text}
      mark={context.mark}
      style={[styles.line, { writingDirection: strings.textDirection(language) }]}
      testID="context-line"
    />
  );
}

const styles = StyleSheet.create({
  line: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, textAlign: 'center' },
  mark: { fontWeight: '700', color: colors.text },
});
