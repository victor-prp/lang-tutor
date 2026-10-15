import type { PhotoImportItem, PhotoImportItemUpdate, PhotoImportOption } from '@lang-tutor/core/api';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { chosenOption, rowNotes } from '@/photoImports';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';
import { alsoLine } from '@/vocabulary';

function Meaning({ option }: { option: PhotoImportOption }) {
  const partOfSpeech = option.part_of_speech ? strings.partOfSpeech(option.part_of_speech) : undefined;
  const also = alsoLine(option.alternatives);
  return (
    <>
      <Text style={styles.translation}>{option.translation}</Text>
      {/* Phase 31. The lookup card's lines, in its order: the gloss's key when it says
          something else, the rendering's other words, then the part of speech. */}
      {option.key ? <Text style={styles.meta}>{option.key}</Text> : null}
      {also ? <Text style={styles.meta}>{also}</Text> : null}
      {partOfSpeech ? <Text style={styles.meta}>{partOfSpeech}</Text> : null}
    </>
  );
}

/**
 * Phase 26 (spec D13). One row of a photo's word list under review: its tick, its word,
 * the sense it is saved as, and its other senses when opened. Every row with a sense
 * starts ticked; any can be unticked or switched to another of its senses.
 *
 * Phase 53. Shared by the review of one import and the target wizard's review of
 * several; each screen sends the changes to its own import and decides what locks a row.
 */
export function PhotoImportRow({
  item,
  wordDirection,
  locked,
  expanded,
  onExpand,
  onChange,
}: {
  item: PhotoImportItem;
  /** The direction of the language being learned, which the word is in. */
  wordDirection: 'rtl' | 'ltr';
  /** A save or discard in flight, or a change of this row that has not landed. */
  locked: boolean;
  /** Whether the row's senses are showing. */
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  onChange: (update: PhotoImportItemUpdate) => void;
}) {
  const choosable = item.status === 'ready' && item.options.length > 0;
  const tickDisabled = !choosable || locked;
  const chosen = chosenOption(item);
  return (
    <View testID="photo-import-row" style={styles.row}>
      <View style={styles.rowTop}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={item.corrected_form ?? item.text}
          accessibilityState={{ checked: item.ticked, disabled: tickDisabled }}
          // react-native-web 0.21 does not render accessibilityState, so on
          // web this is what puts the tick in the DOM (and in a test).
          aria-checked={item.ticked}
          disabled={tickDisabled}
          testID="photo-import-tick"
          hitSlop={8}
          onPress={() => onChange({ ticked: !item.ticked })}
          style={[styles.tick, item.ticked && styles.tickOn, tickDisabled && styles.disabled]}
        >
          {item.ticked ? <Text style={styles.tickMark}>✓</Text> : null}
        </Pressable>
        <Text testID="photo-import-word" style={[styles.word, { writingDirection: wordDirection }]}>
          {item.corrected_form ?? item.text}
        </Text>
      </View>

      {item.status === 'pending' ? (
        <View style={styles.pending}>
          <ActivityIndicator />
          <Text style={styles.meta}>{strings.photoImportPending}</Text>
        </View>
      ) : choosable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded, disabled: locked }}
          disabled={locked}
          testID="photo-import-meaning"
          onPress={() => onExpand(!expanded)}
          style={styles.meaning}
        >
          {chosen ? <Meaning option={chosen} /> : null}
        </Pressable>
      ) : null}

      {expanded && choosable
        ? item.options.map((option) => {
            const selected = option.gloss_id === item.chosen_gloss_id;
            return (
              <Pressable
                key={option.gloss_id}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: locked }}
                aria-selected={selected}
                disabled={locked}
                testID="photo-import-option"
                onPress={() => {
                  onExpand(false);
                  if (!selected) onChange({ gloss_id: option.gloss_id });
                }}
                style={[styles.option, selected && styles.optionSelected]}
              >
                <Meaning option={option} />
                {/* Two members may share a sentence, so the React key adds the place. */}
                {(option.examples ?? []).map((example, index) => (
                  <View key={`${index}:${example.source}`}>
                    <Text style={[styles.exampleSource, { writingDirection: wordDirection }]}>{example.source}</Text>
                    <Text style={styles.meta}>{example.target}</Text>
                  </View>
                ))}
              </Pressable>
            );
          })
        : null}

      {rowNotes(item).map((note) => (
        <Text key={note} testID="photo-import-note" style={styles.note}>
          {note}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tick: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: colors.primary },
  tickMark: { color: colors.onPrimary, fontSize: fontSizes.md, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  word: { flex: 1, fontSize: fontSizes.lg, fontWeight: '700', color: colors.text },
  pending: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  meaning: { gap: spacing.xs },
  translation: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  meta: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  option: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  optionSelected: { borderColor: colors.primary, backgroundColor: colors.background },
  exampleSource: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.text },
  note: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
});
