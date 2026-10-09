import type { VocabularyWordDetail } from '@lang-tutor/core/api';
import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LevelBadge } from '@/components/LevelBadge';
import { SpeakButton } from '@/components/SpeakButton';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useVocabulary } from '@/hooks/useVocabulary';
import { dimensionRows } from '@/progress';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';
import { keepGlossOrder, toggleOptimistically } from '@/vocabulary';

export default function VocabularyWordScreen() {
  const { lemma } = useLocalSearchParams<{ lemma: string }>();
  const { loadWord, save, unsave } = useVocabulary();
  // Phase 23. Every lexeme here is in the active enrollment's target language,
  // and so is each example's source (spec §1 D3).
  const { active } = useCurrentUser();
  const language = active?.target_language ?? null;
  const [word, setWord] = useState<VocabularyWordDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pending, setPending] = useState<Record<string, true>>({});
  // Bumped when the word changes or the screen unmounts: a toggle that settles
  // after that must not write into the next word's state.
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    setWord(null);
    setLoadFailed(false);
    setSaveFailed(false);
    setPending({});
    loadWord(lemma)
      .then((detail) => live && setWord(detail))
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
      generation.current += 1;
    };
  }, [lemma, loadWord]);

  // Optimistic, as on the translate screen. No save-all here: these senses are
  // browsed, not just looked up (spec §5).
  async function toggle(glossId: string) {
    const sense = word?.senses.find((s) => s.gloss_id === glossId);
    if (!sense || pending[glossId]) return;
    const mine = generation.current;
    const ifCurrent = (run: () => void) => {
      if (mine === generation.current) run();
    };
    setSaveFailed(false);
    const ok = await toggleOptimistically({
      next: !sense.saved,
      apply: (saved) =>
        ifCurrent(() =>
          setWord(
            (w) => w && { ...w, senses: w.senses.map((s) => (s.gloss_id === glossId ? { ...s, saved } : s)) },
          ),
        ),
      inFlight: (inFlight) =>
        ifCurrent(() =>
          setPending((current) => {
            const rest = { ...current };
            if (inFlight) rest[glossId] = true;
            else delete rest[glossId];
            return rest;
          }),
        ),
      request: async () => {
        await (sense.saved ? unsave(glossId) : save([{ gloss_id: glossId, variant_id: sense.variant_id }]));
        // Saving or unsaving moves the server's progress rows (unsave deletes them, a
        // new save starts at level 1), so the flipped `saved` alone leaves this screen
        // showing levels the server no longer has. Read the word again, inside the
        // request so the toggle stays disabled until it lands, and keep the senses in
        // the order on screen: the server lists saved ones first. A failed read keeps
        // the word on screen: the toggle itself succeeded.
        try {
          const detail = await loadWord(lemma);
          ifCurrent(() => setWord((shown) => (shown ? keepGlossOrder(shown, detail) : detail)));
        } catch {
          // keep the current word
        }
      },
    });
    ifCurrent(() => setSaveFailed(!ok));
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Pressable accessibilityRole="button" testID="vocabulary-word-back" onPress={() => router.back()}>
        <Text style={styles.link}>{strings.back}</Text>
      </Pressable>

      {loadFailed ? <Text style={styles.notice}>{strings.vocabularyLoadFailed}</Text> : null}
      {saveFailed ? <Text style={styles.notice}>{strings.translateSaveFailed}</Text> : null}
      {!word ? (
        loadFailed ? null : <ActivityIndicator />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <View style={styles.spoken}>
            <Text style={[styles.lemma, styles.grow]}>{word.lemma}</Text>
            {language ? <SpeakButton text={word.lemma} language={language} testID="speak-lemma" /> : null}
          </View>
          {word.level !== null ? <LevelBadge level={word.level} testID="vocabulary-detail-level" /> : null}
          {/* Phase 31: one card per gloss, so the gloss id keys it. */}
          {word.senses.map((sense) => (
            <View key={sense.gloss_id} testID="vocabulary-sense" style={styles.card}>
              {strings.partOfSpeech(sense.part_of_speech) ? (
                <Text testID="vocabulary-sense-pos" style={styles.meta}>
                  {strings.partOfSpeech(sense.part_of_speech)}
                </Text>
              ) : null}
              <Text style={styles.translation}>{sense.translation}</Text>
              {sense.added_by ? (
                <Text testID="vocabulary-sense-added-by" style={styles.addedBy}>
                  {strings.addedBy([sense.added_by])}
                </Text>
              ) : null}
              {sense.form.toLowerCase() !== word.lemma.toLowerCase() ? (
                <Text style={styles.meta}>{strings.vocabularyFromForm(sense.form)}</Text>
              ) : null}
              {/* One example per member sense. Two members may share a sentence,
                  so the key adds the place. */}
              {sense.examples.map((example, index) => (
                <View key={`${index}:${example.source}`} style={styles.example}>
                  <View style={styles.spoken}>
                    <Text style={[styles.exampleSource, styles.grow]}>{example.source}</Text>
                    {language ? (
                      <SpeakButton text={example.source} language={language} testID="speak-example" />
                    ) : null}
                  </View>
                  <Text style={styles.meta}>{example.target}</Text>
                </View>
              ))}
              {sense.saved && sense.progress ? (
                <View style={styles.progress}>
                  <LevelBadge level={sense.progress.level} testID="vocabulary-sense-level" />
                  {dimensionRows(sense.progress, LIVE_DIMENSIONS).map(({ dimension, level }) => (
                    <View key={dimension} style={styles.dimensionRow} testID={`vocabulary-dimension-${dimension}`}>
                      <Text style={styles.meta}>{strings.dimensionName(dimension)}</Text>
                      <Text style={styles.meta}>{level === null ? strings.notPractised : strings.levelName(level)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: sense.saved, disabled: Boolean(pending[sense.gloss_id]) }}
                disabled={Boolean(pending[sense.gloss_id])}
                testID="vocabulary-sense-save"
                onPress={() => void toggle(sense.gloss_id)}
                style={[styles.toggle, sense.saved && styles.toggleSaved]}
              >
                <Text style={[styles.toggleLabel, sense.saved && styles.toggleLabelSaved]}>
                  {sense.saved ? strings.translateSaved : strings.translateSave}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  list: { gap: spacing.sm, paddingBottom: spacing.xl },
  lemma: { fontSize: fontSizes.xl, fontWeight: '700', color: colors.text },
  meta: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  addedBy: { color: colors.muted, fontSize: fontSizes.sm, writingDirection: 'rtl' },
  translation: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.text, writingDirection: 'rtl' },
  example: { gap: spacing.xs },
  progress: { gap: spacing.xs },
  dimensionRow: { flexDirection: 'row', justifyContent: 'space-between' },
  exampleSource: { fontSize: fontSizes.md, color: colors.text },
  spoken: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  grow: { flex: 1 },
  // Same look as translate.tsx: unsaved is a filled primary button, saved is
  // outlined with a primary label (white on the near-white ground is unreadable).
  toggle: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  toggleSaved: { backgroundColor: colors.background },
  toggleLabel: { color: colors.onPrimary, fontSize: fontSizes.sm, fontWeight: '700' },
  toggleLabelSaved: { color: colors.primary },
  notice: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
});
