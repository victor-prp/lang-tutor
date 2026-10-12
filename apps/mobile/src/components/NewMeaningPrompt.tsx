import type { Question } from '@lang-tutor/core/api';
import { StyleSheet, Text, View } from 'react-native';

import { ContextLine } from '@/components/ContextLine';
import { SpeakButton } from '@/components/SpeakButton';
import { contextLanguage } from '@/context';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

type Props = {
  question: Extract<Question, { type: 'new_meaning' }>;
  /** The enrollment's target language: the word and its example are written in it. */
  language: string;
};

/** Phase 39 (spec D6). What a new-meaning card shows above its options: the
 *  word, the meanings the learner already has, the new meaning's example and
 *  the question. The root test id is the card's. */
export function NewMeaningPrompt({ question, language }: Props) {
  return (
    <View style={styles.card} testID="new-meaning-card">
      <View style={styles.promptRow}>
        <Text style={[styles.prompt, { writingDirection: strings.textDirection(language) }]} testID="question-prompt">
          {question.question}
        </Text>
        <SpeakButton text={question.question} language={language} testID="speak-prompt" />
      </View>
      <Text style={styles.known} testID="known-meanings">
        {strings.knownMeanings(question.known_meanings)}
      </Text>
      {question.context ? <ContextLine context={question.context} language={contextLanguage(question.type, language)} /> : null}
      <Text style={styles.question} testID="new-meaning-question">
        {strings.newMeaningQuestion}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md, alignItems: 'center' },
  promptRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  prompt: { flexShrink: 1, fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, textAlign: 'center' },
  known: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
  question: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, fontWeight: '700', textAlign: 'center', writingDirection: 'rtl' },
});
