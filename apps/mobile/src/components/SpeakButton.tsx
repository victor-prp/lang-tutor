import { Pressable, StyleSheet, Text } from 'react-native';

import { useSpeech } from '@/hooks/useSpeech';
import { strings } from '@/strings';
import { colors, fontSizes, radii } from '@/theme';

type Props = {
  /** Exactly what is spoken. */
  text: string;
  /** The language `text` is in, as the wire names it ('it', 'he', …). */
  language: string;
  testID: string;
};

/**
 * Phase 23. Plays `text` in its language. Renders nothing when the device has
 * no voice for that language, and never anything for Hebrew (spec §1 D3, D5),
 * so a call site needs no check of its own.
 */
export function SpeakButton({ text, language, testID }: Props) {
  const speech = useSpeech();
  if (!speech.canSpeak(language)) return null;
  const playing = speech.isPlaying(text, language);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={strings.speak}
      accessibilityState={{ selected: playing }}
      // react-native-web 0.21 does not render accessibilityState (see the level chips).
      aria-selected={playing}
      hitSlop={8}
      testID={testID}
      onPress={() => void speech.toggle(text, language)}
      style={[styles.button, playing && styles.playing]}
    >
      <Text style={styles.glyph}>🔊</Text>
    </Pressable>
  );
}

const SIZE = 40;

const styles = StyleSheet.create({
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playing: { backgroundColor: colors.primary },
  glyph: { fontSize: fontSizes.md },
});
