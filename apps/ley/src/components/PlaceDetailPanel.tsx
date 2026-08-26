import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Linking,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radii, spacing, useDebouncedValue } from '@ley/ui';
import { supabase, useAuth } from '@ley/auth';
import { searchPlaces, PlaceSearchResult } from '../lib/foursquarePlaces';
import { emojiForPlaceId } from '../lib/placeEmoji';
import { SavedPlace } from '../types/place';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
export const PANEL_PEEK_HEIGHT = SCREEN_HEIGHT / 3;
// Welcome/place-detail modes keep their usual partial-height sheet; the add-place search flow
// opens as close to full-screen as the top safe area allows, since it's an active
// search-and-pick task that benefits from the extra room rather than a glanceable summary.
const DEFAULT_PANEL_HEIGHT_FRACTION = 0.58;
const SNAP_DRAG_THRESHOLD = 60;
const SNAP_VELOCITY_THRESHOLD = 0.5;
const SPRING_CONFIG = { damping: 18, mass: 0.9, stiffness: 160, useNativeDriver: true } as const;
const SEARCH_DEBOUNCE_MS = 400;
const MIN_QUERY_LENGTH = 2;

const GALLERY_PLACEHOLDERS = [colors.skyBlue, colors.sageGreen, colors.skyBlue, colors.sageGreen];
const GALLERY_ROWS = [GALLERY_PLACEHOLDERS.slice(0, 2), GALLERY_PLACEHOLDERS.slice(2, 4)];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const SAVED_PLACE_COLUMNS = 'id, name, category, formatted_address, latitude, longitude';

type Props = {
  visible: boolean;
  title: string;
  selectedSavedPlace: SavedPlace | null;
  addingPlace: boolean;
  savedPlaces: SavedPlace[];
  savedPlacesLoading: boolean;
  savedPlacesError: string | null;
  onPlaceSaved: (place: SavedPlace) => void;
};

export function PlaceDetailPanel({
  visible,
  title,
  selectedSavedPlace,
  addingPlace,
  savedPlaces,
  savedPlacesLoading,
  savedPlacesError,
  onPlaceSaved,
}: Props) {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  // The panel's own height never changes — it's always tall enough for its fullest state (the
  // full-height add-place mode). Every other state (hidden/peeked/normal-expanded) is expressed
  // purely as how far down translateY pushes this fixed-height sheet, not by resizing it. Height
  // isn't animatable via the native driver the way transform is (and even a JS-driven height
  // animation looks janky with a ScrollView reflowing inside it mid-transition), so this is what
  // lets switching between add-place's full height and the normal partial height be one smooth
  // spring on translateY — the same animation machinery as every other state change here — rather
  // than a separate, unanimated snap.
  const maxPanelHeight = SCREEN_HEIGHT - insets.top;
  const defaultVisibleHeight = SCREEN_HEIGHT * DEFAULT_PANEL_HEIGHT_FRACTION;
  const [translateY] = useState(() => new Animated.Value(maxPanelHeight));
  const [expanded, setExpanded] = useState(true);
  const dragStartY = useRef(0);
  // maxPanelHeight/addingPlace are read fresh inside the gesture handlers below (created once via
  // useState, so a captured render-scope value would go stale there) — mirrored into refs, kept
  // current after each render via effect (never mutated during render itself — see the ref docs
  // this lint rule links), same reason panelHeightRef used to exist here before height became a
  // fixed constant instead of something measured via onLayout.
  const maxPanelHeightRef = useRef(maxPanelHeight);
  const addingPlaceRef = useRef(addingPlace);
  useEffect(() => {
    maxPanelHeightRef.current = maxPanelHeight;
    addingPlaceRef.current = addingPlace;
  }, [maxPanelHeight, addingPlace]);
  const [notes, setNotes] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<PlaceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const debouncedQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);

  // translateY needed to show exactly `visibleHeight` of the panel above the bottom of the screen.
  const translateYForVisibleHeight = (visibleHeight: number) => maxPanelHeight - visibleHeight;
  // How much of the panel is visible when fully expanded depends on mode: the full fixed height
  // in add-place mode, the usual partial height otherwise.
  const expandedVisibleHeight = addingPlace ? maxPanelHeight : defaultVisibleHeight;

  // Selecting a new saved place (a pin tap), or entering the add-place flow, should always
  // re-open the panel fully, even if it was left peeked from before — adjusted during render
  // (React's recommended pattern for state that depends on a prop change) rather than an effect,
  // since setState-in-effect on every mount triggers a needless extra render.
  const [prevSelectedSavedPlace, setPrevSelectedSavedPlace] = useState(selectedSavedPlace);
  if (selectedSavedPlace !== prevSelectedSavedPlace) {
    setPrevSelectedSavedPlace(selectedSavedPlace);
    if (selectedSavedPlace && !expanded) setExpanded(true);
  }

  const [prevAddingPlace, setPrevAddingPlace] = useState(addingPlace);
  if (addingPlace !== prevAddingPlace) {
    setPrevAddingPlace(addingPlace);
    if (addingPlace) {
      if (!expanded) setExpanded(true);
      setSearchQuery('');
      setSearchResults([]);
      setSelectedPlace(null);
      setSearchError(null);
    }
  }

  useEffect(() => {
    const targetVisibleHeight = !visible ? 0 : expanded ? expandedVisibleHeight : PANEL_PEEK_HEIGHT;
    Animated.spring(translateY, {
      ...SPRING_CONFIG,
      toValue: translateYForVisibleHeight(targetVisibleHeight),
    }).start();
    // translateYForVisibleHeight is a fresh closure every render but is fully determined by
    // maxPanelHeight, which is already listed — adding the function itself would just make the
    // effect re-run on every render for no behavioral difference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, expanded, expandedVisibleHeight, maxPanelHeight, translateY]);

  const trimmedQuery = debouncedQuery.trim();
  const queryTooShort = trimmedQuery.length < MIN_QUERY_LENGTH;

  useEffect(() => {
    // Stale results/errors from a longer query are simply not rendered once the query shrinks
    // below the threshold (see the render below) — no need to clear them here too.
    if (!addingPlace || selectedPlace || queryTooShort) return;
    const query = trimmedQuery;
    let cancelled = false;
    // This is the standard React-docs data-fetching pattern (setState before kicking off the
    // async call, guarded by a `cancelled` flag in the cleanup) — the rule can't tell that from
    // "deriving state synchronously," hence the suppression.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearching(true);
    setSearchError(null);
    searchPlaces(query)
      .then((found) => {
        if (!cancelled) setSearchResults(found);
      })
      .catch((err) => {
        if (!cancelled) setSearchError(err instanceof Error ? err.message : 'Search failed.');
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trimmedQuery, queryTooShort, addingPlace, selectedPlace]);

  // dragStartY/maxPanelHeightRef/addingPlaceRef are only ever read/written inside these handlers,
  // never during render — the rule can't see that the closure is deferred, hence the suppression.
  // eslint-disable-next-line react-hooks/refs
  const [panResponder] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dy) > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderGrant: () => {
        translateY.stopAnimation((value) => {
          dragStartY.current = value;
        });
      },
      onPanResponderMove: (_, gesture) => {
        const maxHeight = maxPanelHeightRef.current;
        const expandedY = maxHeight - (addingPlaceRef.current ? maxHeight : defaultVisibleHeight);
        const peek = maxHeight - PANEL_PEEK_HEIGHT;
        translateY.setValue(clamp(dragStartY.current + gesture.dy, expandedY, peek));
      },
      onPanResponderRelease: (_, gesture) => {
        const maxHeight = maxPanelHeightRef.current;
        const expandedY = maxHeight - (addingPlaceRef.current ? maxHeight : defaultVisibleHeight);
        const peek = maxHeight - PANEL_PEEK_HEIGHT;
        let nextExpanded: boolean;
        if (gesture.dy > SNAP_DRAG_THRESHOLD || gesture.vy > SNAP_VELOCITY_THRESHOLD) {
          nextExpanded = false;
        } else if (gesture.dy < -SNAP_DRAG_THRESHOLD || gesture.vy < -SNAP_VELOCITY_THRESHOLD) {
          nextExpanded = true;
        } else {
          const finalY = clamp(dragStartY.current + gesture.dy, expandedY, peek);
          nextExpanded = finalY < (expandedY + peek) / 2;
        }
        setExpanded(nextExpanded);
        Animated.spring(translateY, {
          ...SPRING_CONFIG,
          toValue: nextExpanded ? expandedY : peek,
        }).start();
      },
    })
  );

  const handleOpenMaps = () => {
    if (!selectedSavedPlace) return;
    Linking.openURL(
      `https://maps.apple.com/?ll=${selectedSavedPlace.latitude},${selectedSavedPlace.longitude}`
    );
  };

  const handleSearchChange = (text: string) => {
    setSearchQuery(text);
    if (selectedPlace) setSelectedPlace(null);
  };

  const handleSelectResult = (result: PlaceSearchResult) => {
    setSelectedPlace(result);
    setSearchQuery(result.name);
    setSearchResults([]);
  };

  const handleAddPlace = async () => {
    if (!selectedPlace || !session?.user || saving) return;
    setSaving(true);
    setSaveError(null);
    const categories = selectedPlace.raw.categories as { name?: string }[] | undefined;
    const { data, error } = await supabase
      .from('saved_places')
      .insert({
        user_id: session.user.id,
        fsq_place_id: selectedPlace.id || null,
        name: selectedPlace.name,
        category: categories?.[0]?.name ?? null,
        latitude: selectedPlace.location?.lat,
        longitude: selectedPlace.location?.lon,
        formatted_address: selectedPlace.formattedAddress ?? null,
        raw_metadata: selectedPlace.raw,
      })
      .select(SAVED_PLACE_COLUMNS)
      .single();
    setSaving(false);
    if (error) {
      setSaveError(error.message);
      return;
    }
    if (data) onPlaceSaved(data);
  };

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.panel, { height: maxPanelHeight, transform: [{ translateY }] }]}
    >
      <View {...panResponder.panHandlers}>
        <View style={styles.headerRow}>
          {selectedSavedPlace ? (
            <Text style={styles.headerEmoji}>{emojiForPlaceId(selectedSavedPlace.id)}</Text>
          ) : null}
          <Text style={styles.title}>{title}</Text>
        </View>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {addingPlace ? (
          <>
            <TextInput
              placeholder={'Search for a place, or "name, city"…'}
              placeholderTextColor={colors.inkSoft}
              value={searchQuery}
              onChangeText={handleSearchChange}
              style={styles.searchInput}
            />

            {queryTooShort ? null : searching ? (
              <ActivityIndicator color={colors.inkSoft} style={styles.searchStatus} />
            ) : searchError ? (
              <Text style={styles.searchError}>{searchError}</Text>
            ) : !selectedPlace && searchResults.length > 0 ? (
              <View style={styles.resultsList}>
                {searchResults.map((result) => (
                  <Pressable
                    key={result.id}
                    onPress={() => handleSelectResult(result)}
                    style={({ pressed }) => [styles.resultRow, pressed && styles.resultRowPressed]}
                  >
                    <Text style={styles.resultName}>{result.name}</Text>
                    {result.formattedAddress ? (
                      <Text style={styles.resultAddress}>{result.formattedAddress}</Text>
                    ) : null}
                  </Pressable>
                ))}
              </View>
            ) : null}

            {selectedPlace ? (
              <>
                <Pressable
                  onPress={handleAddPlace}
                  disabled={saving}
                  style={({ pressed }) => [
                    styles.mapsButton,
                    styles.addPlaceButton,
                    pressed && styles.mapsButtonPressed,
                    saving && styles.addPlaceButtonDisabled,
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator color={colors.inkSoft} />
                  ) : (
                    <Text style={styles.mapsButtonLabel}>Add place</Text>
                  )}
                </Pressable>

                {saveError ? <Text style={styles.searchError}>{saveError}</Text> : null}
              </>
            ) : null}
          </>
        ) : selectedSavedPlace ? (
          <>
            {selectedSavedPlace.category || selectedSavedPlace.formatted_address ? (
              <Text style={styles.selectedPlaceSubtitle}>
                {[selectedSavedPlace.category, selectedSavedPlace.formatted_address]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}

            <View style={styles.gallery}>
              {GALLERY_ROWS.map((row, rowIndex) => (
                <View key={rowIndex} style={styles.galleryRow}>
                  {row.map((color, colIndex) => (
                    <View key={colIndex} style={[styles.photo, { backgroundColor: color }]} />
                  ))}
                </View>
              ))}
            </View>

            <Pressable
              onPress={handleOpenMaps}
              style={({ pressed }) => [styles.mapsButton, pressed && styles.mapsButtonPressed]}
            >
              <Text style={styles.mapsButtonLabel}>Open in Maps</Text>
            </Pressable>

            <TextInput
              placeholder="Add a note about this place…"
              placeholderTextColor={colors.inkSoft}
              value={notes}
              onChangeText={setNotes}
              multiline
              style={styles.notesInput}
            />
          </>
        ) : savedPlacesLoading ? (
          <ActivityIndicator color={colors.inkSoft} style={styles.searchStatus} />
        ) : savedPlacesError ? (
          <Text style={styles.searchError}>{savedPlacesError}</Text>
        ) : savedPlaces.length > 0 ? (
          <View style={styles.resultsList}>
            {savedPlaces.map((place) => (
              <View key={place.id} style={styles.resultRow}>
                <Text style={styles.resultName}>{place.name}</Text>
                {place.category || place.formatted_address ? (
                  <Text style={styles.resultAddress}>
                    {[place.category, place.formatted_address].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.emptyState}>No saved places yet — tap the + button to add one.</Text>
        )}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 15,
    right: 15,
    bottom: 0,
    // Higher than the header's SafeAreaView (zIndex: 1 in HomeScreen.tsx) — only ever matters in
    // the full-height add-place mode, where the panel's top edge reaches the same safe-area row
    // the header occupies; at the normal partial height the two never overlap regardless of order.
    zIndex: 2,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    shadowColor: '#1D2620',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -3 },
    elevation: 3,
  },
  headerRow: {
    marginBottom: spacing.md,
  },
  headerEmoji: {
    fontSize: 32,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  title: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 22,
    color: colors.ink,
    textAlign: 'center',
  },
  selectedPlaceSubtitle: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.inkSoft,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  gallery: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  galleryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  photo: {
    flex: 1,
    height: 110,
    borderRadius: radii.md,
  },
  mapsButton: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  mapsButtonPressed: {
    backgroundColor: colors.hairline,
  },
  mapsButtonLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 16,
    color: colors.ink,
  },
  notesInput: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
    minHeight: 80,
    textAlignVertical: 'top',
    textAlign: 'left',
    borderWidth: 0,
    paddingHorizontal: 0,
  },
  searchInput: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    backgroundColor: colors.panelBackground,
  },
  searchStatus: {
    marginTop: spacing.md,
  },
  searchError: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.error,
    marginTop: spacing.sm,
  },
  resultsList: {
    marginTop: spacing.sm,
  },
  resultRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  resultRowPressed: {
    backgroundColor: colors.panelBackground,
  },
  resultName: {
    fontFamily: fonts.bodyMedium,
    fontSize: 15,
    color: colors.ink,
  },
  resultAddress: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.inkSoft,
    marginTop: 2,
  },
  emptyState: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.inkSoft,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  addPlaceButton: {
    marginTop: spacing.md,
  },
  addPlaceButtonDisabled: {
    opacity: 0.6,
  },
});
