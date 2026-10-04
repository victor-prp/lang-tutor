import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useVocabulary } from '@/hooks/useVocabulary';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';
import { showsMark } from '@/vocabulary';

export default function VocabularyScreen() {
  const { active } = useCurrentUser();
  const v = useVocabulary();
  const { reload } = v;
  // On every focus, including the return from a drill-down: that is what makes
  // a change made there appear here.
  useFocusEffect(useCallback(() => reload(), [reload]));
  if (!active) return <Redirect href="/" />;

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

      <FlatList
        data={v.words}
        keyExtractor={(word) => word.lexeme_id}
        onEndReached={v.loadMore}
        onEndReachedThreshold={0.5}
        refreshing={v.status === 'loading' && v.words.length === 0}
        onRefresh={v.reload}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          v.status === 'ready' ? (
            <View testID="vocabulary-empty" style={styles.empty}>
              <Text style={styles.notice}>{strings.vocabularyEmpty}</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push('/translate')}>
                <Text style={styles.link}>{strings.vocabularyGoTranslate}</Text>
              </Pressable>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const partOfSpeech = strings.partOfSpeech(item.part_of_speech);
          return (
            <Pressable
              accessibilityRole="button"
              testID="vocabulary-word"
              onPress={() => router.push(`/vocabulary/${item.lexeme_id}`)}
              style={styles.row}
            >
              <View style={styles.rowTop}>
                <Text style={styles.lemma}>{item.lemma}</Text>
                {showsMark(item) ? (
                  <Text testID="vocabulary-mark" style={styles.mark}>
                    {strings.vocabularyMark(item.saved_count, item.sense_count)}
                  </Text>
                ) : null}
              </View>
              {partOfSpeech ? <Text style={styles.meta}>{partOfSpeech}</Text> : null}
              <Text style={styles.translation}>{item.headline.translation}</Text>
            </Pressable>
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
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lemma: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text },
  mark: { fontSize: fontSizes.sm, color: colors.muted },
  meta: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  translation: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  empty: { gap: spacing.sm, alignItems: 'center', paddingTop: spacing.xl },
  notice: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
});
