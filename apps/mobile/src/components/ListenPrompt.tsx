import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SpeakButton } from '@/components/SpeakButton';
import { useSpeech } from '@/hooks/useSpeech';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

type Props = {
  /** The card's id: a new card plays again, a re-render does not. */
  questionId: string;
  /** What is spoken, and shown once the card is answered. */
  text: string;
  language: string;
  answered: boolean;
};

/**
 * Phase 24 (spec D6). A listening card's prompt. The word is spoken once on
 * arrival and on every tap, and shown only after the answer. A device with no
 * voice for the language shows it in writing, with a line saying why.
 */
export function ListenPrompt({ questionId, text, language, answered }: Props) {
  const { canSpeak, isPlaying, toggle } = useSpeech();
  const voiced = canSpeak(language);
  // Once per card. React's development double-run of effects would otherwise
  // call toggle twice, and the second call stops the first.
  const played = useRef<string | null>(null);

  useEffect(() => {
    // `voiced` is a dependency so a browser that loads its voices after the
    // first render still plays the card when they arrive.
    if (!voiced || played.current === questionId) return;
    played.current = questionId;
    void toggle(text, language);
  }, [questionId, voiced, text, language, toggle]);

  if (answered || !voiced) {
    return (
      <View style={styles.revealed}>
        <View style={styles.row}>
          <Text style={styles.word} testID="question-prompt">
            {text}
          </Text>
          <SpeakButton text={text} language={language} testID="speak-prompt" />
        </View>
        {voiced ? null : (
          <Text style={styles.note} testID="listen-no-voice">
            {strings.listenNoVoice}
          </Text>
        )}
      </View>
    );
  }

  const playing = isPlaying(text, language);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={strings.listenAgain}
      accessibilityState={{ selected: playing }}
      aria-selected={playing}
      testID="listen-play"
      onPress={() => void toggle(text, language)}
      style={[styles.play, playing && styles.playing]}
    >
      <Text style={styles.glyph}>🔊</Text>
    </Pressable>
  );
}

const PLAY = 96;
const styles = StyleSheet.create({
  revealed: { alignItems: 'center', gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  // The word is the target language: left to right inside the mirrored screen.
  word: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, writingDirection: 'ltr' },
  note: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center' },
  play: {
    alignSelf: 'center',
    width: PLAY,
    height: PLAY,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playing: { backgroundColor: colors.primary },
  glyph: { fontSize: fontSizes.xl },
});
