import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Animated, Easing, PanResponder, Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { dotLook, type StackBar } from '@/targets';
import { colors } from '@/theme';

/** How far a drag goes before it turns the card, in points. */
const SWIPE = 50;
/** The gap between two cards in the row. */
const GAP = 12;
/** The stage's side padding, the room the cards' shadows need inside its overflow. */
const SHADOW_ROOM = 8;
const SLIDE_MS = 280;
/** How long after a drag a click is the drag's own, not a tap (the web's). */
const CLICK_AFTER_DRAG_MS = 500;

/** The DOM node a View is on the web, as much of it as the click guard uses. */
type ClickTarget = {
  addEventListener: (type: 'click', listener: (event: { stopPropagation: () => void; preventDefault: () => void }) => void, capture: boolean) => void;
  removeEventListener: (type: 'click', listener: (event: { stopPropagation: () => void; preventDefault: () => void }) => void, capture: boolean) => void;
};

type IconName = ComponentProps<typeof Ionicons>['name'];
const BAR_ICONS: Record<NonNullable<StackBar['icon']>, IconName> = {
  main: 'book-outline',
  exam: 'calendar-outline',
  homework: 'document-text-outline',
};

/**
 * Phase 64 (spec D3), phase 64b (spec D2–D4). Home's cards, one in view: every card sits in one
 * row, so each is as tall as the tallest, and the row fills the space it is given (no card or
 * control moves when the card changes). The card follows the finger and slides to its
 * neighbour; in RTL the next card is to the left, so a drag to the right brings it, and the row
 * stops at either end. Under it, a named bar per card (StackBar): tapping one brings its card.
 *
 * Back on the first card whenever the order changes (a session finished, a target made) and
 * whenever home comes back into focus (R5).
 */
export function CardStack({
  cards,
  bars,
  resetKey,
}: {
  cards: { key: string; node: ReactNode }[];
  bars: StackBar[];
  resetKey: string;
}) {
  const [index, setIndex] = useState(0);
  const [width, setWidth] = useState(0);
  const count = cards.length;
  const at = count === 0 ? 0 : Math.min(index, count - 1);

  // The row's offset: the card in view at the stage's start, and the finger's drag on top.
  const offset = useRef(new Animated.Value(0)).current;
  const step = width + GAP;

  // Back on the first card at once, never sliding across every card to it (final review): only
  // a tap on a bar or a swipe slides, easing out.
  const reset = useCallback(() => {
    offset.stopAnimation();
    offset.setValue(0);
    setIndex(0);
  }, [offset]);
  useEffect(reset, [resetKey, reset]);
  useFocusEffect(reset);
  const slideTo = useCallback(
    (target: number, stride: number) => {
      setIndex(target);
      Animated.timing(offset, {
        toValue: target * stride,
        duration: SLIDE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start();
    },
    [offset],
  );

  // On the web a Pressable presses on the DOM's click, which follows a drag that ends on it as
  // well (react-native-web's PressResponder): the click a drag leaves behind is swallowed here,
  // before it reaches the card. On a phone the responder's capture already keeps the card out.
  const stageRef = useRef<View>(null);
  const draggedAt = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = stageRef.current as unknown as ClickTarget | null;
    if (!node?.addEventListener) return undefined;
    const swallow = (event: { stopPropagation: () => void; preventDefault: () => void }) => {
      if (Date.now() - draggedAt.current < CLICK_AFTER_DRAG_MS) {
        event.stopPropagation();
        event.preventDefault();
      }
    };
    node.addEventListener('click', swallow, true);
    return () => node.removeEventListener('click', swallow, true);
  }, []);

  // Read through refs: the responder is made once and must see the latest index and size.
  const live = useRef({ at, step, count });
  live.current = { at, step, count };
  const responder = useMemo(() => {
    // A sideways drag is the stack's, claimed in the capture phase, before the card's own
    // pressable: otherwise the card it starts on takes it as a press on release as well. A tap
    // (no move) and a vertical scroll stay the card's and the screen's.
    const sideways = (_: unknown, gesture: { dx: number; dy: number }) =>
      live.current.count > 1 && Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy);
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: sideways,
      onMoveShouldSetPanResponder: sideways,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, gesture) => offset.setValue(live.current.at * live.current.step + gesture.dx),
      onPanResponderRelease: (_, gesture) => {
        draggedAt.current = Date.now();
        const { at: current, step: stride, count: total } = live.current;
        const next = gesture.dx >= SWIPE ? current + 1 : gesture.dx <= -SWIPE ? current - 1 : current;
        const target = Math.max(0, Math.min(total - 1, next));
        if (target !== current) slideTo(target, stride);
        else Animated.spring(offset, { toValue: current * stride, useNativeDriver: false }).start();
      },
      onPanResponderTerminate: () => {
        draggedAt.current = Date.now();
        Animated.spring(offset, { toValue: live.current.at * live.current.step, useNativeDriver: false }).start();
      },
      });
  }, [offset, slideTo]);

  const onLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width - 2 * SHADOW_ROOM;
    if (measured !== width) {
      setWidth(measured);
      offset.setValue(at * (measured + GAP));
    }
  };

  if (count === 0) return null;
  return (
    <View style={styles.stack}>
      <View ref={stageRef} style={styles.stage} onLayout={onLayout} {...responder.panHandlers}>
        <Animated.View testID="home-row" style={[styles.row, { transform: [{ translateX: offset }] }]}>
          {cards.map((card, i) => (
            <Slot key={card.key} hidden={i !== at} width={width}>
              {card.node}
            </Slot>
          ))}
        </Animated.View>
      </View>
      {bars.length > 0 ? (
        <View style={styles.bars}>
          {bars.map((bar, i) => {
            const look = dotLook({ onTop: i === at, urgent: bar.urgent });
            const tint = look === 'on' ? colors.primary : look === 'urgent' ? colors.amber : colors.tabInactive;
            return (
              <Pressable
                key={bar.card}
                accessibilityRole="button"
                accessibilityLabel={bar.spoken}
                accessibilityState={{ selected: i === at }}
                aria-selected={i === at}
                testID={`home-bar-${bar.card}`}
                onPress={() => slideTo(i, step)}
                style={styles.bar}
              >
                <View style={[styles.line, look === 'on' && styles.lineOn, look === 'urgent' && styles.lineUrgent]} />
                <View style={styles.label}>
                  {bar.icon ? <Ionicons name={BAR_ICONS[bar.icon]} size={13} color={tint} /> : null}
                  {bar.label ? (
                    <Text numberOfLines={1} style={[styles.labelText, { color: tint }, look === 'on' && styles.labelOn]}>
                      {bar.label}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** The web's DOM node of a View, as much of it as `Slot` uses. */
type InertTarget = { inert?: boolean };

/**
 * Phase 64b (final review I1). One card's place in the row. Only the card on show is there for a
 * screen reader: the others sit beside it, clipped, and are hidden from accessibility (TalkBack,
 * VoiceOver, the web's aria-hidden) and, on the web, made inert, so a keyboard cannot reach a
 * button on a card nobody sees (and scroll the clipped stage out of line doing it).
 */
function Slot({ hidden, width, children }: { hidden: boolean; width: number; children: ReactNode }) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = ref.current as unknown as InertTarget | null;
    if (node) node.inert = hidden;
  }, [hidden]);
  return (
    <View ref={ref} aria-hidden={hidden} style={[styles.slot, { width }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // Grown from their content, not from zero: the tallest card sets the least height, and the
  // space home gives the stack stretches every card past it.
  stack: { flexGrow: 1, gap: 6 },
  // The cards' shadows need the room the overflow would cut.
  stage: {
    flexGrow: 1,
    overflow: 'hidden',
    marginHorizontal: -SHADOW_ROOM,
    paddingHorizontal: SHADOW_ROOM,
    paddingTop: 2,
    paddingBottom: 14,
  },
  row: { flexGrow: 1, flexDirection: 'row', alignItems: 'stretch', gap: GAP },
  slot: { flexDirection: 'column' },
  bars: { flexDirection: 'row', gap: 6 },
  bar: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', gap: 5 },
  line: { height: 5, borderRadius: 3, backgroundColor: '#D0D5DD' },
  lineOn: { backgroundColor: colors.primary },
  lineUrgent: { backgroundColor: colors.amber },
  label: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 3 },
  labelText: { fontSize: 11, lineHeight: 15, writingDirection: 'rtl' },
  labelOn: { fontWeight: '700' },
});
