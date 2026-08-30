import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { colors, fonts, radii, spacing, useDebouncedValue } from '@ley/ui';
import { supabase, useAuth } from '@ley/auth';
import { searchPlaces, PlaceSearchResult } from '../lib/foursquarePlaces';
import { SavedPlace } from '../types/place';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
// The peeked panel's visible strip is sized to end just above the add-place FAB (HomeScreen.tsx's
// styles.addButton: bottom: insets.bottom + spacing.md, 56x56) rather than extending underneath
// it — computed from that same footprint plus a little breathing room, not a fixed fraction of
// the screen. No direct link to HomeScreen's own styles (nothing to import — it's a sibling
// component's layout, not a shared constant), so if the FAB's size or position ever changes there,
// this needs a matching update.
const FAB_SIZE = 56;
const FAB_BOTTOM_GAP = spacing.md;
// The panel's default open height (a pin tap, or the welcome screen) — a glanceable partial
// sheet, not full-screen. Add-place mode is the exception (always opens straight to 'full', see
// below): it's an active search-and-pick task that benefits from the extra room, not a summary.
const DEFAULT_PANEL_HEIGHT_FRACTION = 0.58;
const SNAP_VELOCITY_THRESHOLD = 0.5;
const SPRING_CONFIG = { damping: 18, mass: 0.9, stiffness: 160, useNativeDriver: true } as const;
const SEARCH_DEBOUNCE_MS = 400;
const MIN_QUERY_LENGTH = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const SAVED_PLACE_COLUMNS = 'id, name, category, formatted_address, latitude, longitude';
const PHOTO_BUCKET = 'saved-place-photos';
const PHOTO_SIGNED_URL_TTL_SECONDS = 60 * 60;

// Three resting heights the panel can snap to, ascending by how open the panel is — a plain
// swipe-to-half default, with a further swipe up (or a fast flick, see onPanResponderRelease
// below) reaching the same full height add-place mode opens to immediately.
type PanelExpansion = 'peeked' | 'half' | 'full';

type Props = {
  visible: boolean;
  title: string;
  selectedSavedPlace: SavedPlace | null;
  addingPlace: boolean;
  savedPlaces: SavedPlace[];
  savedPlacesLoading: boolean;
  savedPlacesError: string | null;
  onPlaceSaved: (place: SavedPlace) => void;
  onPlaceDeleted: (placeId: string) => void;
  onBack: () => void;
  onSelectPlace: (place: SavedPlace) => void;
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
  onPlaceDeleted,
  onBack,
  onSelectPlace,
}: Props) {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  // The panel's own height never changes — it's always tall enough for its fullest state (the
  // full-height add-place mode). Every other state (hidden/peeked/half/full) is expressed purely
  // as how far down translateY pushes this fixed-height sheet, not by resizing it. Height
  // isn't animatable via the native driver the way transform is (and even a JS-driven height
  // animation looks janky with a ScrollView reflowing inside it mid-transition), so this is what
  // lets switching between add-place's full height and the normal partial height be one smooth
  // spring on translateY — the same animation machinery as every other state change here — rather
  // than a separate, unanimated snap.
  const maxPanelHeight = SCREEN_HEIGHT - insets.top;
  const defaultVisibleHeight = SCREEN_HEIGHT * DEFAULT_PANEL_HEIGHT_FRACTION;
  const panelPeekHeight = insets.bottom + FAB_BOTTOM_GAP + FAB_SIZE + FAB_BOTTOM_GAP;
  const [translateY] = useState(() => new Animated.Value(maxPanelHeight));
  const [expansion, setExpansion] = useState<PanelExpansion>('half');
  const dragStartY = useRef(0);
  // maxPanelHeight is read fresh inside the gesture handlers below (created once via useState, so
  // a captured render-scope value would go stale there) — mirrored into a ref, kept current after
  // each render via effect (never mutated during render itself — see the ref docs this lint rule
  // links), same reason panelHeightRef used to exist here before height became a fixed constant
  // instead of something measured via onLayout.
  const maxPanelHeightRef = useRef(maxPanelHeight);
  const panelPeekHeightRef = useRef(panelPeekHeight);
  const expansionRef = useRef(expansion);
  useEffect(() => {
    maxPanelHeightRef.current = maxPanelHeight;
    panelPeekHeightRef.current = panelPeekHeight;
    expansionRef.current = expansion;
  }, [maxPanelHeight, panelPeekHeight, expansion]);
  // translateY's live value, kept current via addListener (fires synchronously on every change,
  // animated or direct) rather than read from stopAnimation's callback in onPanResponderGrant —
  // that callback is asynchronous, so a move event arriving right after grant (routine for a fast
  // continuous drag) could read dragStartY before the callback ever ran, basing that frame's
  // position on a stale prior value and producing a one-frame jump that self-corrects the instant
  // the callback does fire. Confirmed via a 60fps screen recording: the panel visibly snapped to a
  // wrong height for a single frame mid-drag, then immediately recovered. This ref has no such
  // race — it's updated the same tick as every value change, so it's always current by the time
  // onPanResponderGrant reads it.
  const currentTranslateYRef = useRef(maxPanelHeight);
  useEffect(() => {
    const id = translateY.addListener(({ value }) => {
      currentTranslateYRef.current = value;
    });
    return () => translateY.removeListener(id);
  }, [translateY]);
  // The scrollable body's current scroll offset — read (not just written) by bodyPanResponder
  // below to tell "pulling down past an already-top-scrolled list" (collapse the panel) apart from
  // an ordinary scroll-down-then-up. A ref, not state: updates on every scroll frame, far too often
  // to route through a re-render.
  const scrollOffsetRef = useRef(0);
  const [notes, setNotes] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);

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

  // Selecting a new saved place (a pin tap) opens the panel to its default half height, same as
  // the welcome screen — but only if it was left peeked from before; an already half- or
  // fully-open panel stays where the user left it rather than snapping back down. Entering the
  // add-place flow always jumps straight to full, since that's a dedicated full-screen task, not
  // a summary. Adjusted during render (React's recommended pattern for state that depends on a
  // prop change) rather than an effect, since setState-in-effect on every mount triggers a
  // needless extra render.
  const [prevSelectedSavedPlace, setPrevSelectedSavedPlace] = useState(selectedSavedPlace);
  if (selectedSavedPlace !== prevSelectedSavedPlace) {
    setPrevSelectedSavedPlace(selectedSavedPlace);
    if (selectedSavedPlace && expansion === 'peeked') setExpansion('half');
    setIsEditing(false);
    setConfirmingDelete(false);
    setDeleteError(null);
    setUploadError(null);
  }

  const [prevAddingPlace, setPrevAddingPlace] = useState(addingPlace);
  if (addingPlace !== prevAddingPlace) {
    setPrevAddingPlace(addingPlace);
    if (addingPlace) {
      setExpansion('full');
      setSearchQuery('');
      setSearchResults([]);
      setSelectedPlace(null);
      setSearchError(null);
    }
  }

  useEffect(() => {
    const targetVisibleHeight = !visible
      ? 0
      : expansion === 'full'
        ? maxPanelHeight
        : expansion === 'half'
          ? defaultVisibleHeight
          : panelPeekHeight;
    Animated.spring(translateY, {
      ...SPRING_CONFIG,
      toValue: translateYForVisibleHeight(targetVisibleHeight),
    }).start();
    // translateYForVisibleHeight is a fresh closure every render but is fully determined by
    // maxPanelHeight, which is already listed — adding the function itself would just make the
    // effect re-run on every render for no behavioral difference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, expansion, defaultVisibleHeight, panelPeekHeight, maxPanelHeight, translateY]);

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

  const loadPhotoUrls = async (placeId: string): Promise<string[]> => {
    const { data: photos } = await supabase
      .from('saved_place_photos')
      .select('storage_path')
      .eq('saved_place_id', placeId)
      .order('created_at', { ascending: true });
    const paths = (photos ?? []).map((photo) => photo.storage_path);
    if (paths.length === 0) return [];
    const { data: signedUrls } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(paths, PHOTO_SIGNED_URL_TTL_SECONDS);
    return (signedUrls ?? [])
      .map((entry) => entry.signedUrl)
      .filter((url): url is string => Boolean(url));
  };

  useEffect(() => {
    if (!selectedSavedPlace) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPhotoUrls([]);
      return;
    }
    let cancelled = false;
    loadPhotoUrls(selectedSavedPlace.id).then((urls) => {
      if (!cancelled) setPhotoUrls(urls);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSavedPlace]);

  // dragStartY/maxPanelHeightRef/panelPeekHeightRef/expansionRef are only ever read/written inside
  // these handlers, never during render — the rule can't see that the closure is deferred, hence
  // the suppression.
  // eslint-disable-next-line react-hooks/refs
  const [{ headerPanResponder, bodyPanResponder }] = useState(() => {
    const onPanResponderGrant = () => {
      translateY.stopAnimation();
      dragStartY.current = currentTranslateYRef.current;
    };
    const onPanResponderMove = (_: unknown, gesture: { dy: number }) => {
      const maxHeight = maxPanelHeightRef.current;
      const fullY = 0;
      const peekY = maxHeight - panelPeekHeightRef.current;
      translateY.setValue(clamp(dragStartY.current + gesture.dy, fullY, peekY));
    };
    const onPanResponderRelease = (_: unknown, gesture: { dy: number; vy: number }) => {
      const maxHeight = maxPanelHeightRef.current;
      const points: [PanelExpansion, number][] = [
        ['full', 0],
        ['half', maxHeight - SCREEN_HEIGHT * DEFAULT_PANEL_HEIGHT_FRACTION],
        ['peeked', maxHeight - panelPeekHeightRef.current],
      ];
      const finalY = clamp(dragStartY.current + gesture.dy, points[0][1], points[2][1]);
      let nearestIndex = 0;
      for (let i = 1; i < points.length; i++) {
        if (Math.abs(points[i][1] - finalY) < Math.abs(points[nearestIndex][1] - finalY)) {
          nearestIndex = i;
        }
      }
      // A decisive flick (past SNAP_VELOCITY_THRESHOLD) jumps one snap point further in that
      // direction from wherever the release position would otherwise rest, rather than only
      // ever landing exactly where the finger let go — e.g. flicking up from a half-open panel
      // reaches full even mid-drag, matching a native bottom sheet's response to a swipe vs. a
      // slow drag-and-release (which just rests at the nearest point, no nudge).
      //
      // gesture.vy is the *instantaneous* velocity right at release, not the swipe's overall
      // direction — real touchscreens commonly report a tiny reversed blip in that exact instant
      // as a finger lifts off, even mid-swipe while still clearly moving one way overall. Gating
      // the nudge on gesture.dy's sign too (the swipe's net direction, not just its last instant)
      // stops that blip from nudging the wrong way and briefly flickering the panel down before
      // the next render's positioning effect fights it back up to where the swipe actually meant
      // to land — confirmed via screen recording: full height, a snap down to roughly half, then
      // a visible recovery back to full a few frames later.
      let targetIndex = nearestIndex;
      if (gesture.vy < -SNAP_VELOCITY_THRESHOLD && gesture.dy < 0) {
        targetIndex = Math.max(0, nearestIndex - 1);
      } else if (gesture.vy > SNAP_VELOCITY_THRESHOLD && gesture.dy > 0) {
        targetIndex = Math.min(points.length - 1, nearestIndex + 1);
      }
      const [nextExpansion, nextY] = points[targetIndex];
      setExpansion(nextExpansion);
      Animated.spring(translateY, { ...SPRING_CONFIG, toValue: nextY }).start();
    };
    const isVerticalDrag = (gesture: { dy: number; dx: number }) =>
      Math.abs(gesture.dy) > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx);
    // At full height, a downward body drag should only claim the gesture (collapsing the panel)
    // when the list is already scrolled to its top — otherwise it's an ordinary scroll gesture and
    // must be left to ScrollView. scrollOffsetRef is read fresh here for the same reason the other
    // refs are: this closure is created once, so any render-scope value would go stale.
    const shouldClaimBodyDrag = (gesture: { dy: number; dx: number }) => {
      if (!isVerticalDrag(gesture)) return false;
      if (expansionRef.current === 'half') return true;
      return expansionRef.current === 'full' && gesture.dy > 0 && scrollOffsetRef.current <= 0;
    };

    return {
      // The header always drags, in every state — the deliberate "grab handle" for this panel.
      headerPanResponder: PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => isVerticalDrag(gesture),
        onPanResponderGrant,
        onPanResponderMove,
        onPanResponderRelease,
      }),
      // The scrollable body drags in two cases: any vertical drag at half height (see
      // shouldClaimBodyDrag's own comment — half's content is a short, rarely-scrolled preview,
      // so claiming here instead of leaving it to ScrollView means swiping up from anywhere on the
      // panel, not just the header, reaches full height), and a downward drag at full height
      // specifically once already scrolled to the top (pulling further down past the top of a
      // fully-scrolled list reads as "collapse the panel," the same gesture bottom sheets like
      // Apple Maps use — anywhere else in the scrolled content it's still an ordinary scroll).
      // Both onMoveShouldSetPanResponder (bubble phase) and its Capture counterpart claim
      // identically: capture normally wins the race against ScrollView's own native scroll
      // responder for the very first move past the top edge, but isn't guaranteed to on every
      // platform/RN version, so the bubble-phase handler is a second chance at the same claim
      // rather than dead code.
      bodyPanResponder: PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, gesture) => shouldClaimBodyDrag(gesture),
        onMoveShouldSetPanResponder: (_, gesture) => shouldClaimBodyDrag(gesture),
        onPanResponderGrant,
        onPanResponderMove,
        onPanResponderRelease,
      }),
    };
  });

  const handleOpenMaps = () => {
    if (!selectedSavedPlace) return;
    Linking.openURL(
      `https://maps.apple.com/?ll=${selectedSavedPlace.latitude},${selectedSavedPlace.longitude}`
    );
  };

  const handleDeletePlace = async () => {
    if (!selectedSavedPlace || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const { error } = await supabase.from('saved_places').delete().eq('id', selectedSavedPlace.id);
    setDeleting(false);
    if (error) {
      setDeleteError(error.message);
      return;
    }
    setConfirmingDelete(false);
    onPlaceDeleted(selectedSavedPlace.id);
  };

  const handleAddPhoto = async () => {
    if (!selectedSavedPlace || !session?.user || uploadingPhoto) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setUploadError('Photo library access is required to add a photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (result.canceled) return;
    const asset = result.assets[0];
    setUploadingPhoto(true);
    setUploadError(null);
    const arrayBuffer = await fetch(asset.uri).then((res) => res.arrayBuffer());
    const extension = asset.uri.split('.').pop() ?? 'jpg';
    const path = `${session.user.id}/${selectedSavedPlace.id}/${Date.now()}.${extension}`;
    const { error: uploadErr } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, arrayBuffer, { contentType: asset.mimeType ?? 'image/jpeg' });
    if (uploadErr) {
      setUploadingPhoto(false);
      setUploadError(uploadErr.message);
      return;
    }
    const { error: insertErr } = await supabase.from('saved_place_photos').insert({
      saved_place_id: selectedSavedPlace.id,
      user_id: session.user.id,
      storage_path: path,
    });
    if (insertErr) {
      setUploadingPhoto(false);
      setUploadError(insertErr.message);
      return;
    }
    const urls = await loadPhotoUrls(selectedSavedPlace.id);
    setUploadingPhoto(false);
    setPhotoUrls(urls);
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
      <View {...headerPanResponder.panHandlers}>
        <View style={styles.headerRow}>
          {selectedSavedPlace ? (
            <Pressable onPress={onBack} style={styles.headerButton} hitSlop={8}>
              <Text style={styles.headerButtonIcon}>‹</Text>
            </Pressable>
          ) : (
            <View style={styles.headerButtonSpacer} />
          )}
          <Text style={styles.title}>{title}</Text>
          {selectedSavedPlace ? (
            <Pressable
              onPress={() => setIsEditing((prev) => !prev)}
              style={styles.headerButton}
              hitSlop={8}
            >
              <Text style={styles.headerButtonIcon}>{isEditing ? '✓' : '✎'}</Text>
            </Pressable>
          ) : (
            <View style={styles.headerButtonSpacer} />
          )}
        </View>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        // ScrollView's native scroll responder claims a touch on its own, independently of
        // bodyPanResponder's JS-level claim above — the two competing for the same touch is what
        // read as "bouncy" (the list visibly scrolling on its own while the panel was also being
        // resized). Disabling scroll for the same state bodyPanResponder is active in removes the
        // competition entirely, rather than trying to out-negotiate it.
        scrollEnabled={expansion !== 'half'}
        // Even with onMoveShouldSetPanResponderCapture claiming the pull-down-at-top gesture
        // above, a JS PanResponder can't always fully preempt the ScrollView's own native gesture
        // recognizer before it starts reacting — there's inherent latency in the JS/native
        // round-trip, confirmed by this still showing a brief rubber-band on-device even with the
        // capture claim in place. Turning off the elastic overscroll effect itself removes what
        // there is to see, regardless of which side technically wins that race.
        bounces={false}
        onScroll={(e) => {
          scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        {...bodyPanResponder.panHandlers}
      >
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
              <Text style={styles.selectedPlaceSubtitle} onPress={handleOpenMaps}>
                {[selectedSavedPlace.category, selectedSavedPlace.formatted_address]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}

            {photoUrls.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.photoRow}
              >
                {photoUrls.map((url) => (
                  <Image key={url} source={{ uri: url }} style={styles.photoThumbnail} />
                ))}
              </ScrollView>
            ) : null}

            {isEditing ? (
              <TextInput
                placeholder="Add a note about this place…"
                placeholderTextColor={colors.inkSoft}
                value={notes}
                onChangeText={setNotes}
                multiline
                autoFocus
                style={styles.notesInput}
              />
            ) : notes ? (
              <Text style={styles.notesInput}>{notes}</Text>
            ) : null}

            {isEditing ? (
              <>
                <Pressable
                  onPress={handleAddPhoto}
                  disabled={uploadingPhoto}
                  style={({ pressed }) => [
                    styles.mapsButton,
                    pressed && styles.mapsButtonPressed,
                    uploadingPhoto && styles.addPlaceButtonDisabled,
                  ]}
                >
                  {uploadingPhoto ? (
                    <ActivityIndicator color={colors.inkSoft} />
                  ) : (
                    <Text style={styles.mapsButtonLabel}>Add photo</Text>
                  )}
                </Pressable>

                {uploadError ? <Text style={styles.searchError}>{uploadError}</Text> : null}

                <Pressable
                  onPress={() => setConfirmingDelete(true)}
                  style={({ pressed }) => [
                    styles.mapsButton,
                    styles.deleteButton,
                    pressed && styles.mapsButtonPressed,
                  ]}
                >
                  <Text style={[styles.mapsButtonLabel, styles.deleteButtonLabel]}>
                    Delete place
                  </Text>
                </Pressable>
              </>
            ) : null}
          </>
        ) : savedPlacesLoading ? (
          <ActivityIndicator color={colors.inkSoft} style={styles.searchStatus} />
        ) : savedPlacesError ? (
          <Text style={styles.searchError}>{savedPlacesError}</Text>
        ) : savedPlaces.length > 0 ? (
          <View style={styles.resultsList}>
            {savedPlaces.map((place) => (
              <Pressable
                key={place.id}
                onPress={() => onSelectPlace(place)}
                style={({ pressed }) => [styles.resultRow, pressed && styles.resultRowPressed]}
              >
                <Text style={styles.resultName}>{place.name}</Text>
                {place.category || place.formatted_address ? (
                  <Text style={styles.resultAddress}>
                    {[place.category, place.formatted_address].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={styles.emptyState}>No saved places yet — tap the + button to add one.</Text>
        )}
      </ScrollView>

      <Modal
        visible={confirmingDelete}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmingDelete(false)}
      >
        <View style={styles.confirmBackdrop}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmMessage}>
              Are you sure you want to remove {selectedSavedPlace?.name}?
            </Text>
            {deleteError ? <Text style={styles.searchError}>{deleteError}</Text> : null}
            <View style={styles.confirmButtonRow}>
              <Pressable
                onPress={() => setConfirmingDelete(false)}
                disabled={deleting}
                style={({ pressed }) => [styles.confirmButton, pressed && styles.mapsButtonPressed]}
              >
                <Text style={styles.mapsButtonLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleDeletePlace}
                disabled={deleting}
                style={({ pressed }) => [
                  styles.confirmButton,
                  styles.confirmDeleteButton,
                  pressed && styles.mapsButtonPressed,
                  deleting && styles.addPlaceButtonDisabled,
                ]}
              >
                {deleting ? (
                  <ActivityIndicator color={colors.error} />
                ) : (
                  <Text style={[styles.mapsButtonLabel, styles.deleteButtonLabel]}>Delete</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  headerButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButtonSpacer: {
    width: 36,
    height: 36,
  },
  headerButtonIcon: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 21,
    color: colors.inkFaint,
  },
  title: {
    flex: 1,
    fontFamily: fonts.headingSemiBold,
    fontSize: 22,
    color: colors.ink,
    textAlign: 'center',
    marginHorizontal: spacing.sm,
  },
  selectedPlaceSubtitle: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.inkSoft,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  photoRow: {
    marginBottom: spacing.md,
  },
  photoThumbnail: {
    width: 96,
    height: 96,
    borderRadius: radii.md,
    marginRight: spacing.sm,
    backgroundColor: colors.panelBackground,
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
  deleteButton: {
    borderColor: colors.error,
    marginTop: spacing.md,
  },
  deleteButtonLabel: {
    color: colors.error,
  },
  confirmBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(40, 49, 44, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  confirmCard: {
    width: '100%',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  confirmMessage: {
    fontFamily: fonts.bodyMedium,
    fontSize: 16,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  confirmButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  confirmButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmDeleteButton: {
    borderColor: colors.error,
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
