import type { CurrentSessionResponse } from '@lang-tutor/core/api';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { BandCard, cardButton } from '@/components/BandCard';
import { MyWordsToday } from '@/components/MyWordsToday';
import { myWordsButton } from '@/myWordsToday';
import { myWordsBand, type HomeAction, type mainEmptyNote } from '@/nextSession';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, spacing } from '@/theme';

/**
 * Phase 57 (spec D11), phase 64 (spec D4). My words, the main path, as a home card: a blue
 * header with the words due for review (else the meanings saved, or the seed's set) and,
 * under it, today's machinery as it was: start or resume, preparing, the retry after a failed
 * create, skip, and the note when there is nothing of its own. Every button says
 * לתרגל עכשיו (R3); it is solid whenever it starts or resumes a session.
 */
export function MyWordsCard({
  current,
  language,
  ...session
}: {
  current: CurrentSessionResponse | null;
  language: string;
} & Omit<SessionActionProps, 'filled' | 'label'>) {
  const band = current ? myWordsBand(current, language) : null;
  // Phase 73 (spec D5). Today's line, dots and tiles above the button; an older server sends
  // none and the card is as it was. Once the goal is met the button offers more, pale.
  const today = current?.today;
  const button = myWordsButton(today, session.action);
  return (
    <BandCard
      testID="home-my-words"
      icon="book-outline"
      kind={strings.myWords}
      big={band?.big ?? '…'}
      unit={null}
      line={band?.line ?? null}
      info={today ? <MyWordsToday today={today} testID="home-my-words-today" /> : null}
      footer={<SessionAction {...session} filled={button.filled} label={button.label} />}
    />
  );
}

type SessionActionProps = {
  action: HomeAction | null;
  /** Final review M2. What My words says with nothing of its own: save words first, or that
   *  every saved word is in the targets. */
  emptyNote: ReturnType<typeof mainEmptyNote>;
  /** Phase 64 (spec D4). Solid when pressing it starts or resumes a session, else pale. */
  filled: boolean;
  /** Phase 73 (spec D5). לתרגל עכשיו, or לתרגל עוד once the day's goal is met. */
  label: string;
  loadFailed: boolean;
  busy: boolean;
  onRetry: () => void;
  /** Phase 43 (spec D7). Home's own create for the `create` state failed. */
  makeFailed: boolean;
  /** Phase 73 (spec D6). With no words of its own: on to Words for me. */
  onDiscover: () => void;
  onMake: () => void;
  onEnter: (sessionId: string, fresh: boolean) => void;
  onSkip: (sessionId: string) => void;
};

function SessionAction({
  action,
  emptyNote,
  filled,
  label,
  loadFailed,
  busy,
  onRetry,
  makeFailed,
  onDiscover,
  onMake,
  onEnter,
  onSkip,
}: SessionActionProps) {
  const box = filled ? cardButton.solid : cardButton.pale;
  const text = filled ? cardButton.solidLabel : cardButton.paleLabel;
  const primary = (testID: string, label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      disabled={busy}
      onPress={onPress}
      style={[box, busy && cardButton.disabled]}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
  const skip = (sessionId: string) => (
    <Pressable
      accessibilityRole="button"
      testID="home-skip"
      disabled={busy}
      onPress={() => onSkip(sessionId)}
      style={styles.link}
    >
      <Text style={styles.linkLabel}>{strings.skip}</Text>
    </Pressable>
  );
  const preparingLabel = (
    <View testID="preparing-label" style={[box, cardButton.disabled, styles.preparing]}>
      <ActivityIndicator color={filled ? colors.onPrimary : colors.primary} />
      <Text style={text}>{strings.preparingQuestions}</Text>
    </View>
  );
  // Phase 43 (spec D7). Making the next session failed: say so and offer
  // "try again", which makes it again; no button names creating questions.
  const retry = (
    <>
      <Text testID="preparation-failed" style={styles.notice}>
        {strings.preparationFailed}
      </Text>
      {primary('home-make-retry', strings.translateRetry, onMake)}
    </>
  );

  if (!action) {
    if (!loadFailed) return <ActivityIndicator testID="home-loading" />;
    return (
      <>
        <Text testID="home-load-failed" style={styles.notice}>
          {strings.homeLoadFailed}
        </Text>
        <Pressable accessibilityRole="button" testID="home-retry" onPress={onRetry} style={cardButton.pale}>
          <Text style={cardButton.paleLabel}>{strings.translateRetry}</Text>
        </Pressable>
      </>
    );
  }
  switch (action.kind) {
    case 'discover':
      return (
        <>
          {emptyNote.kind === 'all-in-targets' && (
            <Text testID="all-words-in-targets" style={styles.notice}>
              {emptyNote.text}
            </Text>
          )}
          {primary('start-button', label, onDiscover)}
        </>
      );
    case 'create':
      // Phase 43 (spec D7). Home sends create itself: this is how it looks.
      return makeFailed ? retry : preparingLabel;
    case 'preparing':
      return (
        <>
          {preparingLabel}
          {skip(action.sessionId)}
        </>
      );
    case 'start':
    case 'resume':
      return (
        <>
          {primary('start-button', label, () => onEnter(action.sessionId, action.kind === 'start'))}
          {skip(action.sessionId)}
        </>
      );
    case 'failed':
      return retry;
  }
}

const styles = StyleSheet.create({
  preparing: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  notice: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.muted, writingDirection: 'rtl' },
  link: { alignSelf: 'center', paddingVertical: spacing.xs, paddingHorizontal: spacing.md },
  linkLabel: { color: colors.muted, fontSize: fontSizes.sm, lineHeight: lineHeights.sm, fontWeight: '600' },
});
