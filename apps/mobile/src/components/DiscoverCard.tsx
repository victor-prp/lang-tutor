import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { cardButton } from '@/components/BandCard';
import { DiscoverSheet } from '@/components/DiscoverSheet';
import { OptionButton, type OptionVisualState } from '@/components/OptionButton';
import { sheetCaseOf, suggestionOf, type AddChoice } from '@/discovery';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';

/** The fifth row: "אין לי מושג", a pick of no meaning. */
const DONT_KNOW = -1;

/**
 * Phase 74 (spec D1, D2). One card of Words for me: the word, then its four Hebrew meanings and
 * "אין לי מושג" in one column. A pick shows the right meaning green, a wrong pick red, and
 * offers להוסיף / לא להוסיף, the app's suggestion solid. The suggestion answers the card at
 * once; the other choice opens a sheet that explains and offers both again. `onAnswer` sends
 * the pick (null for "אין לי מושג") and the choice; the screen then shows the next card.
 */
export function DiscoverCard({
  word,
  wordDirection,
  choices,
  right,
  added,
  busy,
  onAnswer,
}: {
  word: string;
  wordDirection: 'rtl' | 'ltr';
  choices: readonly string[];
  right: number;
  /** "נוספו n מתוך goal מילים". */
  added: string;
  busy: boolean;
  onAnswer: (pick: number | null, add: boolean) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [sheet, setSheet] = useState<'knew' | 'new' | null>(null);
  const pick = picked === null ? undefined : picked === DONT_KNOW ? null : picked;
  const suggested = pick === undefined ? null : suggestionOf(pick, right);

  const stateOf = (index: number): OptionVisualState => {
    if (picked === null) return 'idle';
    if (index === right) return 'correct';
    if (index === picked) return index === DONT_KNOW ? 'selected' : 'wrong';
    return 'dimmed';
  };

  const choose = (choice: AddChoice) => {
    if (pick === undefined || suggested === null || busy) return;
    const opens = sheetCaseOf(suggested, choice);
    if (opens) setSheet(opens);
    else onAnswer(pick, choice === 'add');
  };
  const answer = (add: boolean) => {
    if (pick === undefined) return;
    setSheet(null);
    onAnswer(pick, add);
  };

  const addSolid = suggested === 'add';
  return (
    <>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text testID="discover-found" style={styles.found}>
          {added}
        </Text>
        <View style={styles.card}>
          <Text testID="discover-word" style={[styles.word, { writingDirection: wordDirection }]}>
            {word}
          </Text>
        </View>
        <View style={styles.choices}>
          {choices.map((choice, index) => (
            <OptionButton
              key={choice}
              label={choice}
              direction="rtl"
              state={stateOf(index)}
              disabled={picked !== null}
              testID={`discover-choice-${index}`}
              onPress={() => setPicked(index)}
              onMeasure={() => {}}
            />
          ))}
          <OptionButton
            label={strings.discoverDontKnow}
            direction="rtl"
            state={stateOf(DONT_KNOW)}
            disabled={picked !== null}
            testID="discover-dont-know"
            onPress={() => setPicked(DONT_KNOW)}
            onMeasure={() => {}}
          />
        </View>
      </ScrollView>
      {suggested !== null ? (
        <View style={styles.decide}>
          <Pressable
            accessibilityRole="button"
            accessibilityHint={addSolid ? 'suggested' : undefined}
            testID="discover-add"
            disabled={busy}
            onPress={() => choose('add')}
            style={[addSolid ? cardButton.solid : cardButton.pale, styles.half, busy && cardButton.disabled]}
          >
            <Text style={addSolid ? cardButton.solidLabel : cardButton.paleLabel}>{strings.discoverAdd}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityHint={addSolid ? undefined : 'suggested'}
            testID="discover-skip"
            disabled={busy}
            onPress={() => choose('skip')}
            style={[addSolid ? cardButton.pale : cardButton.solid, styles.half, busy && cardButton.disabled]}
          >
            <Text style={addSolid ? cardButton.paleLabel : cardButton.solidLabel}>{strings.discoverSkip}</Text>
          </Pressable>
        </View>
      ) : null}
      <DiscoverSheet
        visible={sheet !== null}
        word={word}
        wordDirection={wordDirection}
        meaning={choices[right]}
        title={sheet === 'knew' ? strings.discoverKnewTitle : strings.discoverNewTitle}
        body={sheet === 'knew' ? strings.discoverKnewBody : strings.discoverNewBody}
        // The learner's own choice first, pale; the app's suggestion second, solid (Victor).
        first={
          sheet === 'knew'
            ? { label: strings.discoverAdd, testID: 'discover-sheet-add', onPress: () => answer(true) }
            : { label: strings.discoverSkip, testID: 'discover-sheet-skip', onPress: () => answer(false) }
        }
        second={
          sheet === 'knew'
            ? { label: strings.discoverSkip, testID: 'discover-sheet-skip', onPress: () => answer(false) }
            : { label: strings.discoverAdd, testID: 'discover-sheet-add', onPress: () => answer(true) }
        }
        onDismiss={() => setSheet(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, gap: spacing.md, paddingBottom: spacing.md },
  found: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  card: {
    flexGrow: 1,
    minHeight: 120,
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    ...shadows.card,
  },
  word: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, fontWeight: '800', color: colors.text, textAlign: 'center' },
  choices: { gap: spacing.sm },
  decide: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm },
  half: { flex: 1 },
});
