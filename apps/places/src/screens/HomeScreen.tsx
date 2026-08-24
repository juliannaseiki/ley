import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Globe } from '../components/Globe';
import { PlaceDetailPanel } from '../components/PlaceDetailPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { useAuth, supabase } from '@ley/auth';
import { colors, fonts, radii, spacing } from '@ley/ui';
import { SavedPlace } from '../types/place';

const SAVED_PLACE_COLUMNS = 'id, name, category, formatted_address, latitude, longitude';

function firstNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[.\-_0-9]+/)[0] || local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { session, signOut } = useAuth();
  const [panelVisible, setPanelVisible] = useState(true);
  const [selectedSavedPlace, setSelectedSavedPlace] = useState<SavedPlace | null>(null);
  const [addingPlace, setAddingPlace] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);

  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([]);
  const [savedPlacesLoading, setSavedPlacesLoading] = useState(false);
  const [savedPlacesError, setSavedPlacesError] = useState<string | null>(null);

  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    // Standard React-docs data-fetching pattern (setState before kicking off the async call,
    // guarded by a `cancelled` flag in the cleanup) — the rule can't tell that from "deriving
    // state synchronously," hence the suppression.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedPlacesLoading(true);
    setSavedPlacesError(null);
    supabase
      .from('saved_places')
      .select(SAVED_PLACE_COLUMNS)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setSavedPlacesError(error.message);
        } else {
          setSavedPlaces(data ?? []);
        }
        setSavedPlacesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const handlePinTap = (placeId: string) => {
    const place = savedPlaces.find((p) => p.id === placeId);
    if (!place) return;
    setSelectedSavedPlace(place);
    setAddingPlace(false);
    setPanelVisible(true);
  };

  const handleAddPlace = () => {
    setAddingPlace(true);
    setPanelVisible(true);
  };

  const handlePlaceSaved = (place: SavedPlace) => {
    setSavedPlaces((prev) => [place, ...prev]);
    setAddingPlace(false);
  };

  const email = session?.user?.email;
  const panelTitle = addingPlace
    ? 'Add a place'
    : selectedSavedPlace
      ? selectedSavedPlace.name
      : email
        ? `Welcome ${firstNameFromEmail(email)}`
        : 'Welcome';
  // Placeholder avatar until real profile pictures exist — the same first-name derivation "Welcome
  // {name}" already uses, just reduced to its initial, so the two stay consistent with each other.
  const avatarInitial = email ? firstNameFromEmail(email).charAt(0).toUpperCase() : '?';

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.headerSafe} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>ley</Text>
          <Pressable onPress={() => setSettingsVisible(true)} style={styles.avatarButton} hitSlop={12}>
            <Text style={styles.avatarInitial}>{avatarInitial}</Text>
          </Pressable>
        </View>
      </SafeAreaView>

      <Globe
        onPinTap={handlePinTap}
        savedPlaces={savedPlaces.map((place) => ({
          id: place.id,
          lat: place.latitude,
          lon: place.longitude,
        }))}
      />

      <PlaceDetailPanel
        visible={panelVisible}
        title={panelTitle}
        selectedSavedPlace={selectedSavedPlace}
        addingPlace={addingPlace}
        savedPlaces={savedPlaces}
        savedPlacesLoading={savedPlacesLoading}
        savedPlacesError={savedPlacesError}
        onPlaceSaved={handlePlaceSaved}
      />

      <Pressable
        onPress={handleAddPlace}
        style={[styles.addButton, { bottom: insets.bottom + spacing.md, right: spacing.lg }]}
        hitSlop={8}
      >
        <Text style={styles.addButtonLabel}>+</Text>
      </Pressable>

      <SettingsPanel
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        onLogout={() => signOut()}
      />
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
  avatarButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    color: colors.ink,
  },
  addButton: {
    position: 'absolute',
    // Higher than PlaceDetailPanel's own zIndex (2) so it stays on top of the panel regardless of
    // mode/height, same as it always was via plain source order before the panel needed an
    // explicit zIndex of its own (to render above the header in its full-height add-place mode).
    zIndex: 3,
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
