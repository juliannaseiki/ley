import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Globe } from '../components/Globe';
import { PlaceDetailPanel } from '../components/PlaceDetailPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { useAuth, supabase } from '@ley/auth';
import { colors, fonts, radii, spacing } from '@ley/ui';
import { SavedPlace } from '../types/place';

const SAVED_PLACE_COLUMNS =
  'id, name, category, formatted_address, latitude, longitude, pin_photo_id, pin_thumbnail_path, notes';
const PHOTO_BUCKET = 'saved-place-photos';
const PHOTO_SIGNED_URL_TTL_SECONDS = 60 * 60;

function firstNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[.\-_0-9]+/)[0] || local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function firstNameFromFullName(name: string): string {
  return name.trim().split(/\s+/)[0];
}

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { session, signOut } = useAuth();
  const [panelVisible, setPanelVisible] = useState(true);
  const [selectedSavedPlace, setSelectedSavedPlace] = useState<SavedPlace | null>(null);
  const [addingPlace, setAddingPlace] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);

  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([]);
  const [savedPlacesLoading, setSavedPlacesLoading] = useState(false);
  const [savedPlacesError, setSavedPlacesError] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [pinPhotoUrls, setPinPhotoUrls] = useState<Record<string, string>>({});

  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('name')
      .eq('id', userId)
      .then(({ data }) => {
        if (!cancelled) setProfileName(data?.[0]?.name || null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

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

  useEffect(() => {
    if (savedPlaces.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPinPhotoUrls({});
      return;
    }
    let cancelled = false;
    (async () => {
      const pathByPlaceId = new Map<string, string>();
      // A place with a standalone pin image (LEY-54's "Edit pin") never needs a gallery lookup at
      // all — that path takes precedence over pin_photo_id/the earliest-uploaded fallback (see
      // effectivePinPhotoId in PlaceDetailPanel.tsx).
      for (const place of savedPlaces) {
        if (place.pin_thumbnail_path) pathByPlaceId.set(place.id, place.pin_thumbnail_path);
      }
      const placesNeedingGalleryLookup = savedPlaces.filter((place) => !place.pin_thumbnail_path);
      if (placesNeedingGalleryLookup.length > 0) {
        const { data: rows } = await supabase
          .from('saved_place_photos')
          .select('id, saved_place_id, storage_path, thumbnail_path')
          .in(
            'saved_place_id',
            placesNeedingGalleryLookup.map((place) => place.id)
          )
          .order('created_at', { ascending: true });
        // Pins render a dedicated small thumbnail (LEY-53) rather than the full device-width photo
        // the gallery/panel view uses — thumbnail_path is null for photos uploaded before this
        // pipeline existed, so those fall back to storage_path until re-uploaded.
        const photoById = new Map((rows ?? []).map((row) => [row.id, row.thumbnail_path ?? row.storage_path]));
        // Rows are earliest-first, so the first one seen per place is "the earliest-uploaded
        // photo" — the same default pin_photo_id === null refers to (see LEY-51).
        const earliestPathByPlaceId = new Map<string, string>();
        for (const row of rows ?? []) {
          if (!earliestPathByPlaceId.has(row.saved_place_id)) {
            earliestPathByPlaceId.set(row.saved_place_id, row.thumbnail_path ?? row.storage_path);
          }
        }
        for (const place of placesNeedingGalleryLookup) {
          const path = place.pin_photo_id
            ? (photoById.get(place.pin_photo_id) ?? earliestPathByPlaceId.get(place.id))
            : earliestPathByPlaceId.get(place.id);
          if (path) pathByPlaceId.set(place.id, path);
        }
      }
      if (pathByPlaceId.size === 0) {
        if (!cancelled) setPinPhotoUrls({});
        return;
      }
      const { data: signedUrls } = await supabase.storage
        .from(PHOTO_BUCKET)
        .createSignedUrls(Array.from(pathByPlaceId.values()), PHOTO_SIGNED_URL_TTL_SECONDS);
      const urlByPath = new Map((signedUrls ?? []).map((entry) => [entry.path, entry.signedUrl]));
      const urlByPlaceId: Record<string, string> = {};
      for (const [placeId, path] of pathByPlaceId) {
        const url = urlByPath.get(path);
        if (url) urlByPlaceId[placeId] = url;
      }
      if (!cancelled) setPinPhotoUrls(urlByPlaceId);
    })();
    return () => {
      cancelled = true;
    };
  }, [savedPlaces]);

  // Every one of these actually switches which place is shown (or leaves the panel altogether),
  // so edit mode always resets with them — handlePlaceUpdated (a same-place edit, e.g. setting a
  // pin photo) is deliberately not one of these, since that shouldn't kick the user out of editing.
  const handlePinTap = (placeId: string) => {
    const place = savedPlaces.find((p) => p.id === placeId);
    if (!place) return;
    setSelectedSavedPlace(place);
    setAddingPlace(false);
    setIsEditing(false);
    setPanelVisible(true);
  };

  const handleAddPlace = () => {
    setAddingPlace(true);
    setIsEditing(false);
    setPanelVisible(true);
  };

  const handlePlaceSaved = (place: SavedPlace) => {
    setSavedPlaces((prev) => [place, ...prev]);
    setAddingPlace(false);
  };

  const handlePlaceDeleted = (placeId: string) => {
    setSavedPlaces((prev) => prev.filter((place) => place.id !== placeId));
    setSelectedSavedPlace(null);
    setIsEditing(false);
  };

  const handlePlaceUpdated = (place: SavedPlace) => {
    setSavedPlaces((prev) => prev.map((p) => (p.id === place.id ? place : p)));
    setSelectedSavedPlace((prev) => (prev && prev.id === place.id ? place : prev));
  };

  const handleBackToWelcome = () => {
    setSelectedSavedPlace(null);
    setIsEditing(false);
  };

  const handleSelectSavedPlace = (place: SavedPlace) => {
    setSelectedSavedPlace(place);
    setAddingPlace(false);
    setIsEditing(false);
    setPanelVisible(true);
  };

  const email = session?.user?.email;
  // Profile name (set in Settings) wins when present; email-derived first name is only a fallback
  // for users who haven't set one yet.
  const displayFirstName = profileName
    ? firstNameFromFullName(profileName)
    : email
      ? firstNameFromEmail(email)
      : null;
  const panelTitle = addingPlace
    ? 'Add a place'
    : selectedSavedPlace
      ? selectedSavedPlace.name
      : displayFirstName
        ? `Welcome ${displayFirstName}`
        : 'Welcome';
  // Placeholder avatar until real profile pictures exist — the same first-name derivation "Welcome
  // {name}" already uses, just reduced to its initial, so the two stay consistent with each other.
  const avatarInitial = displayFirstName ? displayFirstName.charAt(0).toUpperCase() : '?';

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
          photoUrl: pinPhotoUrls[place.id],
        }))}
        focusedPlace={
          selectedSavedPlace
            ? { lat: selectedSavedPlace.latitude, lon: selectedSavedPlace.longitude }
            : null
        }
      />

      <PlaceDetailPanel
        visible={panelVisible}
        title={panelTitle}
        selectedSavedPlace={selectedSavedPlace}
        addingPlace={addingPlace}
        isEditing={isEditing}
        savedPlaces={savedPlaces}
        savedPlacesLoading={savedPlacesLoading}
        savedPlacesError={savedPlacesError}
        onPlaceSaved={handlePlaceSaved}
        onPlaceDeleted={handlePlaceDeleted}
        onPlaceUpdated={handlePlaceUpdated}
        onBack={handleBackToWelcome}
        onExitEditing={() => setIsEditing(false)}
        onSelectPlace={handleSelectSavedPlace}
      />

      <Pressable
        onPress={handleAddPlace}
        style={[styles.addButton, { bottom: insets.bottom + spacing.md, right: spacing.lg }]}
        hitSlop={8}
      >
        <Text style={styles.addButtonLabel}>+</Text>
      </Pressable>

      {/* No "Done" toggle — every edit (photos, pin) already saves itself the moment it changes,
          and notes now saves when the panel's own close button is tapped (see handleClose in
          PlaceDetailPanel.tsx), so there's nothing left for a separate "finish editing" action to
          do. This button only starts editing; leaving edit mode happens by leaving the place. */}
      {selectedSavedPlace && !isEditing ? (
        <Pressable
          onPress={() => setIsEditing(true)}
          style={[styles.editButton, { bottom: insets.bottom + spacing.md, left: spacing.lg }]}
          hitSlop={8}
        >
          <Text style={styles.editButtonLabel}>Edit</Text>
        </Pressable>
      ) : null}

      <SettingsPanel
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        onLogout={() => signOut()}
        onNameSaved={setProfileName}
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
  // Mirrors addButton exactly (same size/shape/shadow, opposite corner) so the two floating
  // controls read as a matched pair — only visible once a place is selected, since there's nothing
  // to edit otherwise.
  editButton: {
    position: 'absolute',
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
  editButtonLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    color: colors.ink,
  },
});
