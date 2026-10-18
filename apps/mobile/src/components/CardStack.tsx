import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, View } from 'react-native';

import { dotLook } from '@/targets';
import { colors, radii, shadows } from '@/theme';

/** How far a drag goes before it turns the card, in points. */
const SWIPE = 60;

/**
 * Phase 64 (spec D3, home-carousel.html option 3). Home's cards one at a time, as a stack:
 * the top card, the edges of two more under its bottom edge, and a dot per card (the top
 * one long and blue, a card in its last two days amber). Swiping the top card sideways
 * turns to the next; in RTL the next sits to the left, so a drag to the right brings it,
 * and a drag to the left goes back. The stack cycles. The dots are buttons too, so a mouse
 * reaches every card.
 *
 * Back on the first card whenever the order changes (a session finished, a target made) and
 * whenever home comes back into focus.
 */
export function CardStack({
  cards,
  resetKey,
}: {
  cards: { key: string; urgent: boolean; node: ReactNode }[];
  resetKey: string;
}) {
  const [index, setIndex] = useState(0);
  const count = cards.length;
  const at = count === 0 ? 0 : Math.min(index, count - 1);

  useEffect(() => setIndex(0), [resetKey]);
  useFocusEffect(useCallback(() => setIndex(0), []));

  const pan = useRef(new Animated.Value(0)).current;
  const countRef = useRef(count);
  countRef.current = count;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          countRef.current > 1 && Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderMove: (_, gesture) => pan.setValue(gesture.dx),
        onPanResponderRelease: (_, gesture) => {
          const total = countRef.current;
          if (Math.abs(gesture.dx) >= SWIPE && total > 1) {
            const step = gesture.dx > 0 ? 1 : -1;
            setIndex((current) => (((current + step) % total) + total) % total);
            pan.setValue(0);
            return;
          }
          Animated.spring(pan, { toValue: 0, useNativeDriver: false }).start();
        },
        onPanResponderTerminate: () => Animated.spring(pan, { toValue: 0, useNativeDriver: false }).start(),
      }),
    [pan],
  );

  if (count === 0) return null;
  const several = count > 1;
  return (
    <View style={styles.stack}>
      <View style={[styles.deck, several && styles.deckWithEdges]}>
        {several ? <View style={[styles.edge, styles.edgeBack]} /> : null}
        {several ? <View style={[styles.edge, styles.edgeFront]} /> : null}
        <Animated.View style={[styles.top, { transform: [{ translateX: pan }] }]} {...responder.panHandlers}>
          {cards[at].node}
        </Animated.View>
      </View>
      {several ? (
        <View style={styles.dots}>
          {cards.map((card, i) => {
            const look = dotLook({ onTop: i === at, urgent: card.urgent });
            return (
              <Pressable
                key={card.key}
                accessibilityRole="button"
                accessibilityState={{ selected: i === at }}
                aria-selected={i === at}
                testID={`home-dot-${card.key}`}
                hitSlop={8}
                onPress={() => setIndex(i)}
                style={[styles.dot, look === 'on' && styles.dotOn, look === 'urgent' && styles.dotUrgent]}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  deck: { position: 'relative' },
  deckWithEdges: { paddingBottom: 24 },
  top: { zIndex: 3 },
  edge: {
    position: 'absolute',
    height: 40,
    backgroundColor: colors.surface,
    ...shadows.card,
  },
  edgeFront: { left: 12, right: 12, bottom: 12, borderRadius: 18, zIndex: 2 },
  edgeBack: { left: 24, right: 24, bottom: 0, borderRadius: 16, zIndex: 1, opacity: 0.7 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: radii.pill, backgroundColor: '#D0D5DD' },
  dotOn: { width: 18, backgroundColor: colors.primary },
  dotUrgent: { backgroundColor: colors.amber },
});
