import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Globe } from '../components/Globe';
import { PlaceDetailPanel } from '../components/PlaceDetailPanel';
import { useAuth } from '@ley/auth';
import { colors, fonts, radii, spacing } from '@ley/ui';

function firstNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[.\-_0-9]+/)[0] || local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { session, signOut } = useAuth();
  const [panelVisible, setPanelVisible] = useState(true);
  const [tappedLocation, setTappedLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [addingPlace, setAddingPlace] = useState(false);

  const handleTapLocation = (lat: number, lon: number) => {
    setTappedLocation({ lat, lon });
    setAddingPlace(false);
    setPanelVisible(true);
  };

  const handleAddPlace = () => {
    setAddingPlace(true);
    setPanelVisible(true);
  };

  const email = session?.user?.email;
  const panelTitle = addingPlace
    ? 'Add a place'
    : tappedLocation
      ? 'Dropped Pin'
      : email
        ? `Welcome ${firstNameFromEmail(email)}`
        : 'Welcome';

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

      <Globe onTapLocation={handleTapLocation} />

      <PlaceDetailPanel
        visible={panelVisible}
        title={panelTitle}
        location={tappedLocation}
        addingPlace={addingPlace}
      />

      <Pressable
        onPress={handleAddPlace}
        style={[styles.addButton, { bottom: insets.bottom + spacing.md, right: spacing.lg }]}
        hitSlop={8}
      >
        <Text style={styles.addButtonLabel}>+</Text>
      </Pressable>
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
  addButton: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#1D2620',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  addButtonLabel: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 28,
    lineHeight: 32,
    color: colors.ink,
  },
});
