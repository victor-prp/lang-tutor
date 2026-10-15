import type { MeetQuestion } from '@lang-tutor/core/api';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SpeakButton } from '@/components/SpeakButton';
import { speakingStyles } from '@/components/SpeakingCardView';
import { answerStyles } from '@/components/TypedAnswerView';
import { strings } from '@/strings';

type Props = {
  question: MeetQuestion;
  /** The enrollment's target language: the word on the card is in it. */
  language: string;
  /** The card was tapped through; it waits for the next one. */
  answered: boolean;
  onSeen: () => void;
};

/**
 * Phase 54 (spec D1). A new word, met before it is asked: the word large with
 * its play button, the line asking to say it aloud (nothing is recorded), its
 * Hebrew meaning, and one button. Drawn as the read-aloud card is, from the
 * same pieces. The word is said when the card opens (cardVoice) and on a tap.
 */
export function MeetCardView({ question, language, answered, onSeen }: Props) {
  return (
    <View style={speakingStyles.container}>
      <Text style={[answerStyles.instruction, styles.centred]} testID="meet-title">
        {strings.meetTitle}
      </Text>
      <View style={speakingStyles.row}>
        <Text style={speakingStyles.form} testID="question-prompt">
          {question.question}
        </Text>
        <SpeakButton text={question.question} language={language} testID="speak-form" />
      </View>
      <Text style={[answerStyles.instruction, styles.centred]} testID="meet-say">
        {strings.meetSayAloud}
      </Text>
      <Text style={speakingStyles.meaning} testID="meet-meaning">
        {question.meaning}
      </Text>
      <Pressable
        accessibilityRole="button"
        testID="meet-continue"
        disabled={answered}
        onPress={onSeen}
        style={[answerStyles.check, answered && answerStyles.checkDisabled]}
      >
        <Text style={answerStyles.checkLabel}>{strings.continueLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  centred: { textAlign: 'center' },
});
