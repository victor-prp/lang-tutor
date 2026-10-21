import { Redirect, router, useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { cardButton } from '@/components/BandCard';
import { LevelBadge } from '@/components/LevelBadge';
import { confirm } from '@/confirm';
import { SpeakButton } from '@/components/SpeakButton';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useVocabulary } from '@/hooks/useVocabulary';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, shadows, spacing } from '@/theme';
import { partsOfSpeechLabel, showsMark } from '@/vocabulary';

const LEVELS = [1, 2, 3, 4, 5];

function Separator() {
  return <View style={styles.separator} />;
}

function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      // react-native-web 0.21 does not render accessibilityState, so on web this
      // is the only thing that puts the selected state in the DOM (and in a test).
      aria-selected={selected}
      testID={testID}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Phase 64 (spec D6). The מילים tab: the learner's words, as the vocabulary screen showed them,
 * under the header, with no back button: it is a tab now, not a screen over home.
 */
export default function WordsTab() {
  const { active } = useCurrentUser();
  const v = useVocabulary();
  const { reload } = v;
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  // On every focus, including the return from a drill-down: that is what makes
  // a change made there appear here.
  useFocusEffect(useCallback(() => reload(), [reload]));
  // Phase 64 (spec D2, D6). The header's switcher works from this tab too, and a switch resets
  // the list after the focus reload has started (the provider's effect runs after this screen's),
  // throwing that read away: an idle list on show is read again.
  const focused = useIsFocused();
  useEffect(() => {
    if (focused && v.status === 'idle') reload();
  }, [focused, v.status, reload]);
  if (!active) return <Redirect href="/" />;
  const language = active.target_language;

  // Phase 58 (spec D4), 58b (R2): every word the filter shows, every word on "all".
  const removeShown = async () => {
    if (removing) return;
    const sure = await confirm({
      title: strings.vocabularyRemoveTitle(v.query.level),
      message: strings.vocabularyRemoveMessage,
      confirm: strings.vocabularyRemoveConfirm,
      cancel: strings.cancel,
    });
    if (!sure) return;
    setRemoving(true);
    setRemoveFailed(false);
    try {
      // Resolves once the list has reloaded, so the icon stays disabled until then.
      await v.removeShown();
    } catch {
      setRemoveFailed(true);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={[]}>
      <Text testID="vocabulary-title" style={styles.title}>
        {strings.myWords}
      </Text>
      {/* Phase 69 (spec D1). Words for me: the app finds new words at the learner's level. */}
      <Pressable accessibilityRole="button" testID="discover-entry" onPress={() => router.push('/discover')} style={cardButton.pale}>
        <Text style={cardButton.paleLabel}>{strings.discoverEntry}</Text>
      </Pressable>

      {v.status === 'error' ? (
        <Text style={styles.notice}>{strings.vocabularyLoadFailed}</Text>
      ) : null}

      <View style={styles.chips}>
        <Chip
          testID="vocabulary-level-all"
          label={strings.levelAll}
          selected={v.query.level === null}
          onPress={() => {
            if (v.query.level !== null) {
              setRemoveFailed(false);
              v.setQuery({ level: null });
            }
          }}
        />
        {LEVELS.map((level) => (
          <Chip
            key={level}
            testID={`vocabulary-level-${level}`}
            label={strings.levelName(level)}
            selected={v.query.level === level}
            onPress={() => {
              if (v.query.level !== level) {
                setRemoveFailed(false);
                v.setQuery({ level });
              }
            }}
          />
        ))}
        {/* Phase 58b (R2). An icon, as the speaker is, at the row's end; the question
            it asks names the filter's words, and a screen reader reads its label. */}
        {v.words.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.vocabularyRemoveShown}
            accessibilityState={{ disabled: removing }}
            disabled={removing}
            hitSlop={8}
            testID="vocabulary-remove"
            onPress={() => void removeShown()}
            style={[styles.remove, removing && styles.disabled]}
          >
            <Text style={styles.removeGlyph}>🗑️</Text>
          </Pressable>
        ) : null}
      </View>

      {removeFailed ? (
        <Text testID="vocabulary-remove-failed" style={styles.notice}>
          {strings.vocabularyRemoveFailed}
        </Text>
      ) : null}

      <FlatList
        data={v.words}
        keyExtractor={(word) => word.lemma}
        onEndReached={v.loadMore}
        onEndReachedThreshold={0.5}
        refreshing={v.status === 'loading' && v.words.length === 0}
        onRefresh={v.reload}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          v.status !== 'ready' ? null : v.query.level !== null ? (
            <View testID="vocabulary-empty-level" style={styles.empty}>
              <Text style={styles.notice}>{strings.vocabularyEmptyLevel}</Text>
            </View>
          ) : (
            <View testID="vocabulary-empty" style={styles.empty}>
              <Text style={styles.notice}>{strings.vocabularyEmpty}</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push('/translate')}>
                <Text style={styles.link}>{strings.vocabularyGoTranslate}</Text>
              </Pressable>
            </View>
          )
        }
        renderItem={({ item }) => {
          const partsOfSpeech = partsOfSpeechLabel(item.parts_of_speech);
          return (
            <View style={styles.row}>
              <Pressable
                accessibilityRole="button"
                testID="vocabulary-word"
                onPress={() => router.push({ pathname: '/vocabulary/word', params: { lemma: item.lemma } })}
                style={styles.rowMain}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.lemma}>{item.lemma}</Text>
                  {showsMark(item) ? (
                    <Text testID="vocabulary-mark" style={styles.mark}>
                      {strings.vocabularyMark(item.saved_count, item.gloss_count)}
                    </Text>
                  ) : null}
                </View>
                <LevelBadge level={item.level} testID="vocabulary-word-level" />
                {partsOfSpeech ? <Text style={styles.meta}>{partsOfSpeech}</Text> : null}
                <Text style={styles.translation}>{item.headline.translation}</Text>
                {item.added_by.length > 0 ? (
                  <Text testID="vocabulary-added-by" style={styles.addedBy}>
                    {strings.addedBy(item.added_by)}
                  </Text>
                ) : null}
              </Pressable>
              {/* A sibling, not a child: a button inside the row's button is
                  announced badly by screen readers (spec §1 D10). */}
              <SpeakButton text={item.lemma} language={language} testID="speak-word" />
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  title: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, fontWeight: '800', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  // Phase 64 (spec D6, D9). The words in one white group, a hairline between rows.
  list: {
    backgroundColor: colors.surface,
    borderRadius: radii.group,
    overflow: 'hidden',
    marginBottom: spacing.xl,
    ...shadows.card,
  },
  separator: { height: 1, backgroundColor: colors.hairline, marginHorizontal: spacing.md },
  // Phase 23 (spec §1 D10). The row holds two sibling buttons: the word, which
  // opens it, and its speaker.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingEnd: spacing.md,
    gap: spacing.sm,
  },
  rowMain: { flex: 1, padding: spacing.md, gap: spacing.xs },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lemma: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text },
  mark: { fontSize: fontSizes.sm, color: colors.muted },
  meta: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  translation: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  addedBy: { color: colors.muted, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md - 4,
    boxShadow: '0 1px 2px rgba(16, 24, 40, 0.06)',
  },
  chipSelected: { backgroundColor: colors.primary },
  chipLabel: { fontSize: fontSizes.sm, color: colors.text },
  chipLabelSelected: { color: colors.onPrimary, fontWeight: '700' },
  empty: { gap: spacing.sm, alignItems: 'center', paddingTop: spacing.xl },
  // marginStart: 'auto' pushes the icon to the row's end, whatever the direction.
  remove: { marginStart: 'auto', justifyContent: 'center', paddingHorizontal: spacing.xs },
  removeGlyph: { fontSize: fontSizes.md },
  disabled: { opacity: 0.5 },
  notice: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
});
