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
import { colors, fonts, radii, spacing, useDebouncedValue } from '@ley/ui';
import { supabase, useAuth } from '@ley/auth';
import { searchPlaces, PlaceSearchResult } from '../lib/foursquarePlaces';
import { emojiForPlaceId } from '../lib/placeEmoji';
import { SavedPlace } from '../types/place';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
export const PANEL_PEEK_HEIGHT = SCREEN_HEIGHT / 3;
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
  const [translateY] = useState(() => new Animated.Value(SCREEN_HEIGHT));
  const [expanded, setExpanded] = useState(true);
  const dragStartY = useRef(0);
  // panelHeightRef is read fresh inside the gesture handlers (created once, so state would be
  // stale there); panelHeightMeasured is the same value mirrored into state purely so the
  // positioning effect below re-runs once onLayout reports the real height, instead of running
  // once on mount with height still 0 and never being told to recompute.
  const panelHeightRef = useRef(0);
  const [panelHeightMeasured, setPanelHeightMeasured] = useState(0);
  const [notes, setNotes] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<PlaceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const debouncedQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);

  const peekTranslateY = (height: number) => Math.max(0, height - PANEL_PEEK_HEIGHT);

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
    const target = !visible ? SCREEN_HEIGHT : expanded ? 0 : peekTranslateY(panelHeightMeasured);
    Animated.spring(translateY, { ...SPRING_CONFIG, toValue: target }).start();
  }, [visible, expanded, panelHeightMeasured, translateY]);

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

  // dragStartY/panelHeightRef are only ever read/written inside these handlers, never during
  // render — the rule can't see that the closure is deferred, hence the suppression.
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
        const peek = peekTranslateY(panelHeightRef.current);
        translateY.setValue(clamp(dragStartY.current + gesture.dy, 0, peek));
      },
      onPanResponderRelease: (_, gesture) => {
        const peek = peekTranslateY(panelHeightRef.current);
        let nextExpanded: boolean;
        if (gesture.dy > SNAP_DRAG_THRESHOLD || gesture.vy > SNAP_VELOCITY_THRESHOLD) {
          nextExpanded = false;
        } else if (gesture.dy < -SNAP_DRAG_THRESHOLD || gesture.vy < -SNAP_VELOCITY_THRESHOLD) {
          nextExpanded = true;
        } else {
          const finalY = clamp(dragStartY.current + gesture.dy, 0, peek);
          nextExpanded = finalY < peek / 2;
        }
        setExpanded(nextExpanded);
        Animated.spring(translateY, {
          ...SPRING_CONFIG,
          toValue: nextExpanded ? 0 : peek,
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
      onLayout={(e) => {
        panelHeightRef.current = e.nativeEvent.layout.height;
        setPanelHeightMeasured(e.nativeEvent.layout.height);
      }}
      style={[styles.panel, { transform: [{ translateY }] }]}
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
              placeholder="Search for a place…"
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
    height: '58%',
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
