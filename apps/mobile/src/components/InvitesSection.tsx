import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { pendingInvites } from '@/grants';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

/** Invitations from tutors that wait for this user's answer. */
export function InvitesSection() {
  const { grants, acceptInvite, endGrant } = useCurrentUser();
  // A ref, not state: two taps in one frame must send one request.
  const busy = useRef(false);
  const invites = pendingInvites(grants);
  if (invites.length === 0) return null;

  async function answer(work: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    try {
      await work();
    } catch {
      // The card stays; the next focus re-reads the list.
    } finally {
      busy.current = false;
    }
  }

  return (
    <>
      {invites.map((g) => (
        <View key={g.id} testID="invite-card" style={styles.card}>
          <Text style={styles.cardLabel}>
            {strings.inviteCard(g.grantee.display_name, g.enrollment.target_language)}
          </Text>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              testID="invite-accept"
              onPress={() => answer(() => acceptInvite(g.id))}
              style={[styles.button, styles.accept]}
            >
              <Text style={styles.acceptLabel}>{strings.inviteAccept}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="invite-decline"
              onPress={() => answer(() => endGrant(g.id))}
              style={[styles.button, styles.decline]}
            >
              <Text style={styles.declineLabel}>{strings.inviteDecline}</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardLabel: {
    fontSize: fontSizes.lg,
    lineHeight: lineHeights.lg,
    color: colors.text,
    writingDirection: 'rtl',
  },
  row: { flexDirection: 'row', gap: spacing.sm },
  button: { flex: 1, borderRadius: radii.md, paddingVertical: spacing.md, alignItems: 'center' },
  accept: { backgroundColor: colors.primary },
  acceptLabel: {
    color: colors.onPrimary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
  decline: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  declineLabel: {
    color: colors.primary,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.md,
    fontWeight: '700',
  },
});
