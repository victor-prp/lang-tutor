import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LevelBadge } from '@/components/LevelBadge';
import { SpeakButton } from '@/components/SpeakButton';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useVocabulary } from '@/hooks/useVocabulary';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';
import { partsOfSpeechLabel, showsMark } from '@/vocabulary';

const LEVELS = [1, 2, 3, 4, 5];

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

export default function VocabularyScreen() {
  const { active } = useCurrentUser();
  const v = useVocabulary();
  const { reload } = v;
  // On every focus, including the return from a drill-down: that is what makes
  // a change made there appear here.
  useFocusEffect(useCallback(() => reload(), [reload]));
  if (!active) return <Redirect href="/" />;
  const language = active.target_language;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="vocabulary-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text testID="vocabulary-title" style={styles.title}>
          {strings.vocabularyTitle(active.target_language)}
        </Text>
      </View>

      {v.status === 'error' ? (
        <Text style={styles.notice}>{strings.vocabularyLoadFailed}</Text>
      ) : null}

      <View style={styles.chips}>
        <Chip
          testID="vocabulary-level-all"
          label={strings.levelAll}
          selected={v.query.level === null}
          onPress={() => {
            if (v.query.level !== null) v.setQuery({ level: null });
          }}
        />
        {LEVELS.map((level) => (
          <Chip
            key={level}
            testID={`vocabulary-level-${level}`}
            label={strings.levelName(level)}
            selected={v.query.level === level}
            onPress={() => {
              if (v.query.level !== level) v.setQuery({ level });
            }}
          />
        ))}
      </View>

      <FlatList
        data={v.words}
        keyExtractor={(word) => word.lemma}
        onEndReached={v.loadMore}
        onEndReachedThreshold={0.5}
        refreshing={v.status === 'loading' && v.words.length === 0}
        onRefresh={v.reload}
        contentContainerStyle={styles.list}
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
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  list: { gap: spacing.sm, paddingBottom: spacing.xl },
  // Phase 23 (spec §1 D10). The card holds two sibling buttons: the word, which
  // opens it, and its speaker.
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
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
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { fontSize: fontSizes.sm, color: colors.text },
  chipLabelSelected: { color: colors.onPrimary, fontWeight: '700' },
  empty: { gap: spacing.sm, alignItems: 'center', paddingTop: spacing.xl },
  notice: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
});
