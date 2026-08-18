import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Globe } from '../components/Globe';
import { useAuth } from '@ley/auth';
import { colors, fonts, spacing } from '@ley/ui';

export function HomeScreen() {
  const { signOut } = useAuth();

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.headerSafe} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>ley</Text>
          <Pressable onPress={() => signOut()} hitSlop={12}>
            <Text style={styles.signOut}>Log out</Text>
          </Pressable>
        </View>
      </SafeAreaView>

      <Globe />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  headerSafe: {
    backgroundColor: colors.background,
    zIndex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  wordmark: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 22,
    color: colors.ink,
  },
  signOut: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    color: colors.inkSoft,
  },
});
