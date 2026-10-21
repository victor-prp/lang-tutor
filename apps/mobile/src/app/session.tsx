import type { ClozeChoiceQuestion, ClozeTypedQuestion, LanguageCode, Question, SentenceTranslationQuestion } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MarkedText, type SentenceTaps } from '@/components/ContextLine';
import { FeedbackBanner } from '@/components/FeedbackBanner';
import { LetterTilesView } from '@/components/LetterTilesView';
import { MatchingBoardView } from '@/components/MatchingBoardView';
import { MeetCardView } from '@/components/MeetCardView';
import { MultipleChoiceView } from '@/components/MultipleChoiceView';
import { NewMeaningPrompt } from '@/components/NewMeaningPrompt';
import { ProgressBar } from '@/components/ProgressBar';
import { SentenceCorrection } from '@/components/SentenceCorrection';
import { SentenceGap } from '@/components/SentenceGap';
import { SpeakButton } from '@/components/SpeakButton';
import { TappableSentence } from '@/components/TappableSentence';
import { SpeakingCardView } from '@/components/SpeakingCardView';
import { TypedAnswerView } from '@/components/TypedAnswerView';
import { confirm } from '@/confirm';
import { sentenceFeedback, sentenceLine } from '@/explain';
import { feedbackFor } from '@/feedback';
import { useCardVoice } from '@/hooks/useCardVoice';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNextSession } from '@/hooks/useNextSession';
import { useSession, type SessionValue } from '@/hooks/useSession';
import { showsSentenceTranslation, splitAtGap } from '@/sentence';
import { hasBanner } from '@/speaking';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';
import { scriptGate } from '@/typedSubmit';

// Phase 27 (spec D5). The gap card's prompt: the sentence with its blank, the
// Hebrew line under it, and once answered the sentence spoken. Phase 34 (spec
// D8): a typed gap's Hebrew line marks the practised word. Phase 38 (spec D1):
// a typed gap's Hebrew line is a hint, a button until it is opened.
type GapHint = { open: boolean; retrying: boolean; onOpen: () => void };

// Phase 62 (spec D3). A gap card's sentence is tapped word by word when its map
// holds the gap as its practised word; otherwise, a card from before the phase
// or one the server could not map, it is the plain sentence with its blank.
const mapsGap = (question: ClozeChoiceQuestion | ClozeTypedQuestion) =>
  question.words?.some((word) => word.target && word.start === question.gap.start && word.end === question.gap.end) ?? false;

function gapPrompt(question: ClozeChoiceQuestion | ClozeTypedQuestion, taps: SentenceTaps, language: string, testID?: string, hint?: GapHint) {
  const answered = taps.answered;
  const shown = showsSentenceTranslation(question.type, { answered, hintOpen: hint?.open ?? false, retrying: hint?.retrying ?? false });
  return (
    <View style={styles.gapCard} testID={testID}>
      {mapsGap(question) ? (
        <TappableSentence
          text={question.sentence}
          words={question.words}
          mark={null}
          tapped={taps.tapped}
          onTap={answered ? null : taps.onTap}
          hint={answered ? null : strings.tapWordHint(taps.learner)}
          style={styles.gapSentence}
          testID="sentence-gap"
          direction="ltr"
          reveal={answered}
          gap
          targetTappable={false}
        />
      ) : (
        <SentenceGap sentence={question.sentence} gap={question.gap} filled={answered} />
      )}
      {shown ? (
        <MarkedText
          text={question.translation}
          mark={question.type === 'cloze_typed' ? question.mark : null}
          style={styles.hebrewLine}
          testID="sentence-translation"
        />
      ) : hint ? (
        <Pressable accessibilityRole="button" testID="sentence-hint" hitSlop={8} onPress={hint.onOpen}>
          <Text style={styles.hint}>{strings.sentenceHint}</Text>
        </Pressable>
      ) : null}
      {answered ? <SpeakButton text={question.sentence} language={language} testID="speak-sentence" /> : null}
    </View>
  );
}

// Phase 27 (spec D6). The translation card's prompt: the Hebrew sentence and,
// once judged, the reference with its practised word in bold. Phase 34 (spec
// D8): the Hebrew sentence marks the practised word too.
function translatePrompt(question: SentenceTranslationQuestion, session: SessionValue, language: string) {
  const answered = session.answered;
  const { before, word, after } = splitAtGap(question.sentence, question.gap);
  return (
    <View style={styles.gapCard}>
      {/* Phase 59 (spec D3): each word a tap shows the Italian of; the practised word's is help.
          Phase 59c (design A): the Italian under the word, and a line saying so until the answer. */}
      <TappableSentence
        text={question.question}
        words={question.words}
        mark={question.mark}
        tapped={session.tapped}
        onTap={answered ? null : session.pressWord}
        hint={answered || !question.words ? null : strings.tapWordHint(language)}
        style={styles.hebrewPrompt}
        testID="sentence-translation"
        // Phase 62 (spec D5): once answered, every word's Italian.
        reveal={answered}
      />
      {/* Phase 63 (spec D9). A card with no word map shows no Italian under its
          words, so the practised word tapped shows its form here instead. */}
      {!answered && !question.words && session.help > 0 ? (
        <Text style={styles.markAnswer} testID="sentence-mark-answer">
          {question.answer}
        </Text>
      ) : null}
      {answered ? (
        <View style={styles.reference}>
          <Text style={styles.referenceLabel}>{strings.translationReference}</Text>
          <View style={styles.referenceRow}>
            <Text style={styles.referenceText} testID="translation-reference">
              {before}
              <Text style={styles.bold}>{word}</Text>
              {after}
            </Text>
            <SpeakButton text={question.sentence} language={language} testID="speak-reference" />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// Phase 62 (spec D3, D5). What a card that taps a sentence needs of the session.
function tapsOf(session: SessionValue, learner: string): SentenceTaps {
  return { tapped: session.tapped, onTap: session.pressWord, answered: session.answered, learner };
}

// Phase 56 (spec D5, D6). Help on a card, the count the session keeps for it.
// Phase 63 (spec D3): and the marks of the last press on a typed card.
function helpOf(session: SessionValue) {
  return { presses: session.help, onPress: session.pressHelp, marks: session.helpMarks };
}

// Phase 55 (spec D7). A typed card's verdict, for its input's border: a retype
// that ended tells how it ended. Phase 56 (spec D7): every typed card has one or none.
function verdictOf(question: Question, session: SessionValue) {
  return session.answer ? feedbackFor(question, session.answer, session.retry, session.retype).verdict : null;
}

// Phase 55 (spec D7). The retype after a wrong or nearly right first answer, under
// that answer's title. Phase 56 (spec D7): on a typed meaning, dictation, typed gap
// and typed say the translation too; the session opens it only where it applies.
function retypeOf(question: Question, session: SessionValue) {
  return {
    retype: session.retype,
    retypeTitle: session.answer ? feedbackFor(question, session.answer, session.retry).title : undefined,
    onRetypeTyping: session.retypeTyping,
    onRetype: session.retypeChecked,
  };
}

// Phase 38 (spec D1, D4). The typed gap card holds whether its hint is open, and
// sends it with the first answer. Keyed by question id, so a new card starts closed.
// Phase 56 (spec D1): letter help beside the hint, which stays recorded and ungraded.
function ClozeTypedCard({ question, session, language, learner, answerLanguage }: { question: ClozeTypedQuestion; session: SessionValue; language: string; learner: string; answerLanguage: LanguageCode | null }) {
  const [hintOpen, setHintOpen] = useState(false);
  return (
    <TypedAnswerView
      question={question}
      instruction={strings.questionInstructionClozeTyped(language)}
      answerLanguage={answerLanguage}
      language={language}
      answered={session.answered}
      verdict={verdictOf(question, session)}
      onSubmit={(text) => session.submitText(text, { hintOpened: hintOpen })}
      direction="ltr"
      checking={session.judging === 'checking'}
      failed={session.judging === 'failed'}
      retry={session.retry}
      prompt={gapPrompt(question, tapsOf(session, learner), language, undefined, {
        open: hintOpen,
        retrying: session.retry !== null,
        onOpen: () => setHintOpen(true),
      })}
      help={helpOf(session)}
      {...retypeOf(question, session)}
    />
  );
}

// The one place the session screen dispatches on question type. Adding a type
// means a new case here plus a view component; the header, progress bar,
// feedback banner and scoring are untouched, and the `never` below fails the
// build for a type with no case.
function renderQuestion(question: Question, session: SessionValue, language: string, learner: string, explainOpen: boolean) {
  // Phase 39 (spec D7, D8): the language a typed card's answer is checked in, by the server's rule.
  const answerLanguage = scriptGate(question, language, learner);
  switch (question.type) {
    case 'multiple_choice':
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstruction}
          language={language}
          selectedOption={session.selectedOption}
          onSelect={session.select}
          taps={tapsOf(session, learner)}
          help={helpOf(session)}
        />
      );
    case 'new_meaning':
      // Phase 39 (spec D6): a choice of meanings, under a prompt that names the ones already known.
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstructionNewMeaning}
          prompt={<NewMeaningPrompt question={question} language={language} taps={tapsOf(session, learner)} />}
          language={language}
          selectedOption={session.selectedOption}
          onSelect={session.select}
        />
      );
    case 'reverse_choice':
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstructionReverse(language)}
          language={language}
          selectedOption={session.selectedOption}
          onSelect={session.select}
          help={helpOf(session)}
        />
      );
    case 'typed_translation':
      // Phase 34 (spec D9): another accepted word waits for the server to hold
      // the card, so it checks and fails as a judged card does. Phase 55 (spec
      // D7): help, said with the answer, and the retype after a wrong or nearly
      // right first answer, under that answer's title. Keyed by question id
      // (review M2), as the tiles card is: a new card starts with no help shown.
      return (
        <TypedAnswerView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionTyped(language)}
          answerLanguage={answerLanguage}
          language={language}
          answered={session.answered}
          verdict={verdictOf(question, session)}
          onSubmit={(text) => session.submitText(text)}
          direction="ltr"
          checking={session.judging === 'checking'}
          failed={session.judging === 'failed'}
          retry={session.retry}
          help={helpOf(session)}
          {...retypeOf(question, session)}
        />
      );
    case 'cloze_choice':
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstructionCloze}
          language={language}
          selectedOption={session.selectedOption}
          onSelect={session.select}
          prompt={gapPrompt(question, tapsOf(session, learner), language, 'cloze-card')}
          help={helpOf(session)}
        />
      );
    case 'cloze_typed':
      // Judged on the phone against the gap's word, as a typed translation is.
      return <ClozeTypedCard key={question.id} question={question} session={session} language={language} learner={learner} answerLanguage={answerLanguage} />;
    case 'sentence_translation':
      // Phase 56 (spec D1): no retype. Phase 63 (spec D9): no help button either:
      // its words are tapped, and a tap on the practised word is the help.
      return (
        <TypedAnswerView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionTranslate(language)}
          answerLanguage={answerLanguage}
          language={language}
          answered={session.answered}
          verdict={verdictOf(question, session)}
          direction="ltr"
          checking={session.judging === 'checking'}
          failed={session.judging === 'failed'}
          onSubmit={session.submitJudged}
          retry={session.retry}
          prompt={translatePrompt(question, session, language)}
          // Phase 66b (spec D2): the sentence's check, which came with the word's grade.
          sentence={sentenceLine(session.explanation)}
          below={
            session.explanation !== null && session.answer !== null && 'text' in session.answer ? (
              <SentenceCorrection text={session.answer.text} explanation={session.explanation} open={explainOpen} />
            ) : null
          }
        />
      );
    case 'typed_meaning':
      // Phase 56 (spec D1, D7): help reveals the stored meaning, right to left; the
      // retype opens on the judge's wrong.
      return (
        <TypedAnswerView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionMeaning(learner)}
          answerLanguage={answerLanguage}
          language={language}
          answered={session.answered}
          verdict={verdictOf(question, session)}
          direction="rtl"
          checking={session.judging === 'checking'}
          failed={session.judging === 'failed'}
          onSubmit={session.submitJudged}
          retry={session.retry}
          help={helpOf(session)}
          {...retypeOf(question, session)}
          taps={tapsOf(session, learner)}
        />
      );
    case 'listen_choice':
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstructionListen}
          language={language}
          selectedOption={session.selectedOption}
          onSelect={session.select}
          help={helpOf(session)}
        />
      );
    case 'dictation':
      // Phase 56 (spec D1, D7): help reveals the heard form; a wrong one is typed again.
      return (
        <TypedAnswerView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionDictation(language)}
          answerLanguage={answerLanguage}
          language={language}
          answered={session.answered}
          verdict={verdictOf(question, session)}
          onSubmit={(text) => session.submitText(text)}
          direction="ltr"
          checking={false}
          failed={false}
          retry={null}
          help={helpOf(session)}
          {...retypeOf(question, session)}
        />
      );
    case 'letter_tiles':
      // Phase 55 (spec D7): each tile checked as placed; the card answers itself, saying whether it was helped.
      return (
        <LetterTilesView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionTiles(language)}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
          onSubmit={(text, helped) => session.submitText(text, { helped })}
        />
      );
    case 'matching':
      return (
        <MatchingBoardView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionMatching}
          language={language}
          answered={session.answered}
          onComplete={session.submitBoard}
        />
      );
    case 'read_aloud':
      // Spec D8: with speaking off, the card is passed unseen.
      if (session.speakingOff !== null) return null;
      return (
        <SpeakingCardView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionReadAloud}
          language={language}
          answer={session.answer}
          speech={session.speech}
          onClip={session.submitSpeech}
          onRetry={session.retrySpeech}
          onPass={session.pass}
          onCantSpeak={session.stopSpeaking}
          onRecordFailed={session.markSpeechFailed}
          retry={null}
        />
      );
    case 'meet':
      // Phase 54 (spec D1): a new word, met before it is asked. Ungraded, and
      // independent of speaking. Phase 55 (spec D1): saying it is the read-aloud card's.
      return <MeetCardView key={question.id} question={question} language={language} answered={session.answered} onSeen={session.seen} />;
    case 'say_translation':
      // Spec D8: with speaking off, the same card is typed.
      // Phase 56 (spec D5): one help count for the card, so letters shown while
      // speaking stay shown once it is typed.
      if (session.speakingOff !== null) {
        return (
          <View style={styles.typedForm}>
            <TypedAnswerView
              key={question.id}
              question={question}
              instruction={strings.questionInstructionTyped(language)}
              answerLanguage={answerLanguage}
              language={language}
              answered={session.answered}
              verdict={verdictOf(question, session)}
              onSubmit={(text) => session.submitText(text)}
              direction="ltr"
              checking={session.judging === 'checking'}
              failed={session.judging === 'failed'}
              retry={session.retry}
              help={helpOf(session)}
              {...retypeOf(question, session)}
            />
          </View>
        );
      }
      return (
        <SpeakingCardView
          key={question.id}
          question={question}
          instruction={strings.questionInstructionSay(language)}
          language={language}
          answer={session.answer}
          speech={session.speech}
          onClip={session.submitSpeech}
          onRetry={session.retrySpeech}
          onPass={session.pass}
          onCantSpeak={session.stopSpeaking}
          onRecordFailed={session.markSpeechFailed}
          retry={session.retry}
          help={helpOf(session)}
        />
      );
    default: {
      const unhandled: never = question;
      throw new Error(`unhandled question type: ${JSON.stringify(unhandled)}`);
    }
  }
}

export default function SessionScreen() {
  const session = useSession();
  const next = useNextSession();
  const { active } = useCurrentUser();
  // Re-entry guard: a fast double tap on skip must not stack two confirms.
  const skipping = useRef(false);
  // Phase 66b (spec D2). The card whose sentence's reasons הסבר opened, by its id,
  // so the next card starts closed. They open under the banner, which covers the
  // bottom of the screen, so the screen scrolls down to them.
  const [explained, setExplained] = useState<string | null>(null);
  const explainOpen = session.question !== undefined && explained === session.question.id;
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (explainOpen) requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
  }, [explainOpen]);
  // The keyboard covers the lower half of the screen, where a tall card's input
  // and its בדיקה sit: once it is up, the card shows its end, and its prompt is a
  // scroll away. iOS makes room before this event; Android makes it after, which
  // the ScrollView's onLayout below catches.
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => scroll.current?.scrollToEnd({ animated: true }));
    return () => shown.remove();
  }, []);
  // A session is always entered from home, which needs an active enrollment;
  // an empty language only drops the name from the instruction.
  const language = active?.target_language ?? '';
  // Phase 44 (spec D2): the card reads itself aloud. Phase 55 (spec D7): a
  // retype opens showing the answer, so the word is said then, as for a banner,
  // and not again when its banner follows: the cue reads the answer, not the retype.
  useCardVoice(session.question ?? null, {
    language,
    banner: session.answer !== null && hasBanner(session.answer),
    speaking: session.speakingOff === null,
  });
  // Phase 27: what a meaning card last sent, so "try again" sends the same text.

  // Results replaces Session in the stack, so backing out of Results reaches
  // Home rather than a finished quiz.
  useEffect(() => {
    if (session.hasSession && session.complete) {
      router.replace('/results');
    }
  }, [session.hasSession, session.complete]);

  async function onSkip() {
    const sessionId = session.sessionId;
    if (!sessionId || skipping.current) return;
    skipping.current = true;
    try {
      const sure = await confirm({
        title: strings.skipConfirmTitle,
        message: strings.skipConfirmMessage,
        confirm: strings.skip,
        cancel: strings.cancel,
      });
      if (!sure) return;
      // A failure needs nothing more here: home re-reads the state on focus.
      await next.skip(sessionId).catch(() => undefined);
      router.dismissTo('/');
    } finally {
      skipping.current = false;
    }
  }

  if (!session.hasSession) {
    return <Redirect href="/" />;
  }

  const question = session.question;
  if (!question) {
    return null;
  }

  // Phase 39 (spec D9): a typed meaning is answered in the learner's language.
  const learner = active?.source_language ?? 'he';
  const line = sentenceLine(session.explanation);
  const banner = session.answer !== null && hasBanner(session.answer, session.retype);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* The keyboard must not cover the typed card's input and its button. Padding
          on Android too: it draws edge to edge (target SDK 35+, mandatory from
          Android 16), where the system no longer shrinks the screen for the keyboard. */}
      <KeyboardAvoidingView style={styles.avoid} behavior="padding">
        <View style={styles.header}>
          <Pressable accessibilityRole="button" testID="session-back" hitSlop={12} onPress={() => router.back()}>
            <Text style={styles.back}>{'→'}</Text>
          </Pressable>
          <View style={styles.headerEnd}>
            <Text style={styles.counter} testID="progress-label">
              {strings.progressLabel(session.position, session.total)}
            </Text>
            <Pressable accessibilityRole="button" testID="session-skip" hitSlop={12} onPress={() => void onSkip()}>
              <Text style={styles.skip}>{strings.skip}</Text>
            </Pressable>
          </View>
        </View>

        <ProgressBar position={session.position} total={session.total} />

        {/* "handled": with the keyboard up, the first tap on בדיקה must submit,
            not merely dismiss the keyboard. */}
        <ScrollView
          ref={scroll}
          contentContainerStyle={[styles.body, banner && styles.bodyUnderBanner]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onLayout={() => {
            if (Keyboard.isVisible()) scroll.current?.scrollToEnd({ animated: true });
          }}
        >
          {/* Spec D7: a refused microphone says so once, above whatever card is
              current, for the rest of the session. */}
          {session.speakingOff === 'no_mic' ? (
            <Text style={styles.noMic} testID="speak-no-mic">
              {strings.noMicrophone}
            </Text>
          ) : null}
          {renderQuestion(question, session, language, learner, explainOpen)}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Phase 55 (spec D7): none while a retype is open; then how it ended. */}
      {/* Phase 66b (spec D2): a translation's sentence line under its word's. */}
      {session.answer && hasBanner(session.answer, session.retype) ? (
        <FeedbackBanner
          feedback={sentenceFeedback(feedbackFor(question, session.answer, session.retry, session.retype), line)}
          onContinue={session.next}
          sentence={line === null ? null : { line, open: explainOpen, onExplain: () => setExplained(explainOpen ? null : question.id) }}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  gapCard: { gap: spacing.md, alignItems: 'center' },
  hebrewLine: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
  hint: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.primary, fontWeight: '700', writingDirection: 'rtl' },
  hebrewPrompt: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, textAlign: 'center', writingDirection: 'rtl' },
  // Phase 62 (spec D3): a gap sentence tapped word by word, as SentenceGap sets it.
  gapSentence: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, textAlign: 'center', writingDirection: 'ltr' },
  reference: { gap: spacing.xs, alignItems: 'center' },
  referenceLabel: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
  // Phase 63 (spec D9). The practised word's form, tapped on a card with no word map: the target language.
  markAnswer: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.primary, fontWeight: '600', textAlign: 'center', writingDirection: 'ltr' },
  referenceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  referenceText: { flexShrink: 1, fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.text, textAlign: 'center', writingDirection: 'ltr' },
  bold: { fontWeight: '700' },
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  avoid: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
  },
  // A glyph, not an icon, so it is not auto-mirrored. Back points right in RTL.
  back: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.muted },
  // Direction is handled in the string itself: see strings.progressLabel.
  counter: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    color: colors.muted,
    fontWeight: '700',
  },
  headerEnd: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  skip: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, fontWeight: '700' },
  // Bottom padding keeps the last option clear of the overlaid banner.
  typedForm: { gap: spacing.md },
  noMic: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, textAlign: 'center', paddingBottom: spacing.md },
  body: { paddingTop: spacing.xl, paddingBottom: spacing.xl },
  // Room under the last option for the banner laid over it. Not while it is
  // away: the card's end, the end the keyboard scrolls to, is its button.
  bodyUnderBanner: { paddingBottom: spacing.xxl * 4 },
});
