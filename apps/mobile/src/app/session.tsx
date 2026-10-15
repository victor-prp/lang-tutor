import type { ClozeChoiceQuestion, ClozeTypedQuestion, LanguageCode, Question, SentenceTranslationQuestion } from '@lang-tutor/core/api';
import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MarkedText } from '@/components/ContextLine';
import { FeedbackBanner } from '@/components/FeedbackBanner';
import { LetterTilesView } from '@/components/LetterTilesView';
import { MatchingBoardView } from '@/components/MatchingBoardView';
import { MeetCardView } from '@/components/MeetCardView';
import { MultipleChoiceView } from '@/components/MultipleChoiceView';
import { NewMeaningPrompt } from '@/components/NewMeaningPrompt';
import { ProgressBar } from '@/components/ProgressBar';
import { SentenceGap } from '@/components/SentenceGap';
import { SpeakButton } from '@/components/SpeakButton';
import { SpeakingCardView } from '@/components/SpeakingCardView';
import { TypedAnswerView } from '@/components/TypedAnswerView';
import { confirm } from '@/confirm';
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

function gapPrompt(question: ClozeChoiceQuestion | ClozeTypedQuestion, answered: boolean, language: string, testID?: string, hint?: GapHint) {
  const shown = showsSentenceTranslation(question.type, { answered, hintOpen: hint?.open ?? false, retrying: hint?.retrying ?? false });
  return (
    <View style={styles.gapCard} testID={testID}>
      <SentenceGap sentence={question.sentence} gap={question.gap} filled={answered} />
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
function translatePrompt(question: SentenceTranslationQuestion, answered: boolean, language: string) {
  const { before, word, after } = splitAtGap(question.sentence, question.gap);
  return (
    <View style={styles.gapCard}>
      <MarkedText text={question.question} mark={question.mark} style={styles.hebrewPrompt} testID="sentence-translation" />
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

// Phase 38 (spec D1, D4). The typed gap card holds whether its hint is open, and
// sends it with the first answer. Keyed by question id, so a new card starts closed.
function ClozeTypedCard({ question, session, language, answerLanguage }: { question: ClozeTypedQuestion; session: SessionValue; language: string; answerLanguage: LanguageCode | null }) {
  const [hintOpen, setHintOpen] = useState(false);
  return (
    <TypedAnswerView
      question={question}
      instruction={strings.questionInstructionClozeTyped(language)}
      answerLanguage={answerLanguage}
      language={language}
      answered={session.answered}
      verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
      onSubmit={(text) => session.submitText(text, hintOpen)}
      direction="ltr"
      checking={session.judging === 'checking'}
      failed={session.judging === 'failed'}
      retry={session.retry}
      prompt={gapPrompt(question, session.answered, language, undefined, {
        open: hintOpen,
        retrying: session.retry !== null,
        onOpen: () => setHintOpen(true),
      })}
    />
  );
}

// The one place the session screen dispatches on question type. Adding a type
// means a new case here plus a view component; the header, progress bar,
// feedback banner and scoring are untouched, and the `never` below fails the
// build for a type with no case.
function renderQuestion(question: Question, session: SessionValue, language: string, learner: string) {
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
        />
      );
    case 'new_meaning':
      // Phase 39 (spec D6): a choice of meanings, under a prompt that names the ones already known.
      return (
        <MultipleChoiceView
          question={question}
          instruction={strings.questionInstructionNewMeaning}
          prompt={<NewMeaningPrompt question={question} language={language} />}
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
        />
      );
    case 'typed_translation':
      // Phase 34 (spec D9): another accepted word waits for the server to hold
      // the card, so it checks and fails as a judged card does.
      return (
        <TypedAnswerView
          question={question}
          instruction={strings.questionInstructionTyped(language)}
          answerLanguage={answerLanguage}
          language={language}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
          onSubmit={session.submitText}
          direction="ltr"
          checking={session.judging === 'checking'}
          failed={session.judging === 'failed'}
          retry={session.retry}
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
          prompt={gapPrompt(question, session.answered, language, 'cloze-card')}
        />
      );
    case 'cloze_typed':
      // Judged on the phone against the gap's word, as a typed translation is.
      return <ClozeTypedCard key={question.id} question={question} session={session} language={language} answerLanguage={answerLanguage} />;
    case 'sentence_translation':
      return (
        <TypedAnswerView
          question={question}
          instruction={strings.questionInstructionTranslate(language)}
          answerLanguage={answerLanguage}
          language={language}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
          direction="ltr"
          checking={session.judging === 'checking'}
          failed={session.judging === 'failed'}
          onSubmit={session.submitJudged}
          retry={session.retry}
          prompt={translatePrompt(question, session.answered, language)}
        />
      );
    case 'typed_meaning':
      return (
        <TypedAnswerView
          question={question}
          instruction={strings.questionInstructionMeaning(learner)}
          answerLanguage={answerLanguage}
          language={language}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
          direction="rtl"
          checking={session.judging === 'checking'}
          failed={session.judging === 'failed'}
          onSubmit={session.submitJudged}
          retry={session.retry}
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
        />
      );
    case 'dictation':
      return (
        <TypedAnswerView
          question={question}
          instruction={strings.questionInstructionDictation(language)}
          answerLanguage={answerLanguage}
          language={language}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
          onSubmit={session.submitText}
          direction="ltr"
          checking={false}
          failed={false}
          retry={null}
        />
      );
    case 'letter_tiles':
      return (
        <LetterTilesView
          question={question}
          instruction={strings.questionInstructionTiles(language)}
          answered={session.answered}
          verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
          onSubmit={session.submitText}
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
      // independent of speaking: it asks the learner to say it, and records nothing.
      return <MeetCardView key={question.id} question={question} language={language} answered={session.answered} onSeen={session.seen} />;
    case 'say_translation':
      // Spec D8: with speaking off, the same card is typed.
      if (session.speakingOff !== null) {
        return (
          <View style={styles.typedForm}>
            <TypedAnswerView
              question={question}
              instruction={strings.questionInstructionTyped(language)}
              answerLanguage={answerLanguage}
              language={language}
              answered={session.answered}
              verdict={session.answer ? feedbackFor(question, session.answer, session.retry).verdict : null}
              onSubmit={session.submitText}
              direction="ltr"
              checking={session.judging === 'checking'}
              failed={session.judging === 'failed'}
              retry={session.retry}
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
  // A session is always entered from home, which needs an active enrollment;
  // an empty language only drops the name from the instruction.
  const language = active?.target_language ?? '';
  // Phase 44 (spec D2): the card reads itself aloud.
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

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* The keyboard must not cover the typed card's input and its button. */}
      <KeyboardAvoidingView style={styles.avoid} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Spec D7: a refused microphone says so once, above whatever card is
              current, for the rest of the session. */}
          {session.speakingOff === 'no_mic' ? (
            <Text style={styles.noMic} testID="speak-no-mic">
              {strings.noMicrophone}
            </Text>
          ) : null}
          {renderQuestion(question, session, language, learner)}
        </ScrollView>
      </KeyboardAvoidingView>

      {session.answer && hasBanner(session.answer) ? (
        <FeedbackBanner feedback={feedbackFor(question, session.answer, session.retry)} onContinue={session.next} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  gapCard: { gap: spacing.md, alignItems: 'center' },
  hebrewLine: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, textAlign: 'center', writingDirection: 'rtl' },
  hint: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.primary, fontWeight: '700', writingDirection: 'rtl' },
  hebrewPrompt: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, color: colors.text, textAlign: 'center', writingDirection: 'rtl' },
  reference: { gap: spacing.xs, alignItems: 'center' },
  referenceLabel: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm, color: colors.muted, writingDirection: 'rtl' },
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
  body: { paddingTop: spacing.xl, paddingBottom: spacing.xxl * 4 },
});
