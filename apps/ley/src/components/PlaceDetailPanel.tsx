import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  Linking,
  Modal,
  PanResponder,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { colors, fonts, radii, spacing, useDebouncedValue } from '@ley/ui';
import { supabase, useAuth } from '@ley/auth';
import { searchPlaces, PlaceSearchResult } from '../lib/foursquarePlaces';
import { SavedPlace } from '../types/place';

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');
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

const SAVED_PLACE_COLUMNS =
  'id, name, category, formatted_address, latitude, longitude, pin_photo_id, pin_thumbnail_path, notes';
const PHOTO_BUCKET = 'saved-place-photos';
const PHOTO_SIGNED_URL_TTL_SECONDS = 60 * 60;
const SAVED_PLACE_CARD_HEIGHT = 96;

// Same set + hash as emojiForPlaceId in webview-src/globe-entry.js, so a place's list-view fallback
// matches its globe pin — kept as a separate copy since the webview bundle isn't reachable from
// here, but both are pure functions of the place id, so there's nothing to keep in sync at runtime.
const PIN_FLOWER_EMOJIS = ['🌸', '🌷', '🌹', '🌺', '🌻', '🌼'];
function emojiForPlaceId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PIN_FLOWER_EMOJIS[hash % PIN_FLOWER_EMOJIS.length];
}

type SavedPlacePhoto = {
  id: string;
  storagePath: string;
  thumbnailPath: string | null;
  url: string;
};

// The grid always renders 1 or 2 rows of up to 2 cells, in upload order: 1 photo is a single
// full-width cell, 2 sit side by side, 3 form a 2x2 grid with the trailing cell left empty (a
// `null` placeholder — later filled with an icon, see LEY-51/52), and 4 fill the 2x2 grid
// completely. `null` cells are never emitted past the last photo, so a 1- or 2-photo grid stays a
// single row rather than gaining a blank second row.
function getPhotoGridRows(photos: SavedPlacePhoto[]): (SavedPlacePhoto | null)[][] {
  const capped = photos.slice(0, MAX_PHOTOS);
  switch (capped.length) {
    case 0:
      return [];
    case 1:
    case 2:
      return [capped];
    case 3:
      return [
        [capped[0], capped[1]],
        [capped[2], null],
      ];
    default:
      return [
        [capped[0], capped[1]],
        [capped[2], capped[3]],
      ];
  }
}

// Cap the longer side of an uploaded photo to the device's own screen width in physical pixels —
// camera originals (often 3000-4000px+) are far larger than that, so uploading them unresized
// wastes upload/download bandwidth for no visual benefit. Device width (rather than a flat
// constant) leaves room for a future full-width photo view to render these at native resolution.
const MAX_PHOTO_DIMENSION = Math.round(SCREEN_WIDTH * PixelRatio.get());
const PHOTO_COMPRESSION_QUALITY = 0.7;
// The dedicated pin thumbnail (LEY-53): globe pins render at PIN_RADIUS*2 = 30 CSS px, scaled by
// at most DPR_CAP = 2 in globe-entry.js, so 64px physical pixels comfortably covers every device —
// versus the full device-width photo (MAX_PHOTO_DIMENSION) previously reused for pin fills, which
// was a known contributor to pin-rendering performance issues. A thumbnail is only ever generated
// for a photo that's actually going to be a pin (the place's first photo, which becomes the
// default pin — see effectivePinPhotoId below — a photo the user explicitly pins later via
// handleSetPinPhoto, or a photo picked specifically for the pin via handleEditPin), not for every
// photo in the gallery.
const PIN_THUMBNAIL_DIMENSION = 64;
// The pin-shape preview rendered next to "Edit pin" (LEY-54) — sized to match the globe's own pin
// exactly: PIN_RADIUS*2 CSS px in globe-entry.js, which are the same logical-pixel units as RN's
// own point-based sizing here.
const PIN_SHAPE_SIZE = 30;

// Shared by every place a thumbnail gets generated: a fresh upload's first photo (handleAddPhoto,
// from a local picker asset), an explicit re-pin of an already-uploaded photo (handleSetPinPhoto,
// from a data URI decoded off the photo's signed URL — ImageManipulator only accepts a local file
// or data URI, not a remote http(s) one), or a photo picked specifically for the pin
// (handleEditPin, also from a local picker asset). Passing only `width` lets ImageManipulator
// preserve the source aspect ratio automatically, so this doesn't need to know the source's
// dimensions.
async function createPinThumbnailUri(sourceUri: string): Promise<string> {
  const context = ImageManipulator.manipulate(sourceUri);
  context.resize({ width: PIN_THUMBNAIL_DIMENSION });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_COMPRESSION_QUALITY });
  return saved.uri;
}
// The grid's own cap, matching the max grid cell count getPhotoGridRows lays out for (1 row of 2
// cells, or a 2x2 grid) — also the ceiling handleAddPhoto enforces when uploading.
const MAX_PHOTOS = 4;

// Three resting heights the panel can snap to, ascending by how open the panel is — a plain
// swipe-to-half default, with a further swipe up (or a fast flick, see onPanResponderRelease
// below) reaching the same full height add-place mode opens to immediately.
type PanelExpansion = 'peeked' | 'half' | 'full';

type Props = {
  visible: boolean;
  title: string;
  selectedSavedPlace: SavedPlace | null;
  addingPlace: boolean;
  // Owned by HomeScreen now, not this component — its own toggle moved out of this panel's header
  // and into a floating FAB next to the add-place one (see HomeScreen.tsx), which needed a way to
  // read/drive this same state from outside.
  isEditing: boolean;
  savedPlaces: SavedPlace[];
  savedPlacesLoading: boolean;
  savedPlacesError: string | null;
  onPlaceSaved: (place: SavedPlace) => void;
  onPlaceDeleted: (placeId: string) => void;
  onPlaceUpdated: (place: SavedPlace) => void;
  onBack: () => void;
  // Leaves edit mode without leaving the place — the header's top-left icon while editing ("‹"
  // instead of "✕") calls this instead of onBack.
  onExitEditing: () => void;
  onSelectPlace: (place: SavedPlace) => void;
};

export function PlaceDetailPanel({
  visible,
  title,
  selectedSavedPlace,
  addingPlace,
  isEditing,
  savedPlaces,
  savedPlacesLoading,
  savedPlacesError,
  onPlaceSaved,
  onPlaceDeleted,
  onPlaceUpdated,
  onBack,
  onExitEditing,
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
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<SavedPlacePhoto[]>([]);
  const [confirmingDeletePhoto, setConfirmingDeletePhoto] = useState<SavedPlacePhoto | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState(false);
  const [deletePhotoError, setDeletePhotoError] = useState<string | null>(null);
  const [settingPinPhoto, setSettingPinPhoto] = useState(false);
  const [pinPhotoError, setPinPhotoError] = useState<string | null>(null);
  const [editingPin, setEditingPin] = useState(false);
  const [editPinError, setEditPinError] = useState<string | null>(null);
  const [pinPreviewUrl, setPinPreviewUrl] = useState<string | null>(null);
  const [savedPlacePhotoUrls, setSavedPlacePhotoUrls] = useState<Record<string, string>>({});

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
  // Compared by id, not object identity — onPlaceUpdated (e.g. setting a pin photo) hands down a
  // new SavedPlace object for the same place, which shouldn't reset this state the way actually
  // switching to a different place (a pin tap) should. isEditing itself is reset by HomeScreen,
  // which owns that state now — see its own selection handlers.
  const [prevSelectedSavedPlaceId, setPrevSelectedSavedPlaceId] = useState(selectedSavedPlace?.id ?? null);
  if ((selectedSavedPlace?.id ?? null) !== prevSelectedSavedPlaceId) {
    setPrevSelectedSavedPlaceId(selectedSavedPlace?.id ?? null);
    if (selectedSavedPlace && expansion === 'peeked') setExpansion('half');
    setNotes(selectedSavedPlace?.notes ?? '');
    setNotesError(null);
    setConfirmingDelete(false);
    setDeleteError(null);
    setUploadError(null);
    setConfirmingDeletePhoto(null);
    setDeletePhotoError(null);
    setPinPhotoError(null);
    setEditPinError(null);
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

  const loadPhotos = async (placeId: string): Promise<SavedPlacePhoto[]> => {
    const { data: rows } = await supabase
      .from('saved_place_photos')
      .select('id, storage_path, thumbnail_path')
      .eq('saved_place_id', placeId)
      .order('created_at', { ascending: true });
    if (!rows || rows.length === 0) return [];
    const { data: signedUrls } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(
        rows.map((row) => row.storage_path),
        PHOTO_SIGNED_URL_TTL_SECONDS
      );
    const urlByPath = new Map((signedUrls ?? []).map((entry) => [entry.path, entry.signedUrl]));
    return rows
      .map((row) => ({
        id: row.id,
        storagePath: row.storage_path,
        thumbnailPath: row.thumbnail_path,
        url: urlByPath.get(row.storage_path),
      }))
      .filter((photo): photo is SavedPlacePhoto => Boolean(photo.url));
  };

  useEffect(() => {
    if (!selectedSavedPlace) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPhotos([]);
      return;
    }
    let cancelled = false;
    loadPhotos(selectedSavedPlace.id).then((loaded) => {
      if (!cancelled) setPhotos(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSavedPlace]);

  // A standalone pin (LEY-54's "Edit pin") takes precedence over any gallery photo — see the
  // matching precedence in HomeScreen.tsx's own pin resolution. photos is ordered earliest-first
  // (see loadPhotos), so photos[0] is exactly "the earliest-uploaded photo" the null default
  // (no standalone pin, no explicit pin_photo_id) refers to.
  const effectivePinPhotoId = selectedSavedPlace?.pin_thumbnail_path
    ? null
    : (selectedSavedPlace?.pin_photo_id ?? photos[0]?.id ?? null);

  useEffect(() => {
    if (!selectedSavedPlace) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPinPreviewUrl(null);
      return;
    }
    if (selectedSavedPlace.pin_thumbnail_path) {
      let cancelled = false;
      const path = selectedSavedPlace.pin_thumbnail_path;
      supabase.storage
        .from(PHOTO_BUCKET)
        .createSignedUrl(path, PHOTO_SIGNED_URL_TTL_SECONDS)
        .then(({ data }) => {
          if (!cancelled) setPinPreviewUrl(data?.signedUrl ?? null);
        });
      return () => {
        cancelled = true;
      };
    }
    const pinnedPhoto = photos.find((photo) => photo.id === effectivePinPhotoId);
    setPinPreviewUrl(pinnedPhoto?.url ?? null);
  }, [selectedSavedPlace, photos, effectivePinPhotoId]);

  useEffect(() => {
    if (savedPlaces.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSavedPlacePhotoUrls({});
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from('saved_place_photos')
        .select('saved_place_id, storage_path')
        .in(
          'saved_place_id',
          savedPlaces.map((place) => place.id)
        )
        .order('created_at', { ascending: false });
      if (!rows || rows.length === 0) {
        if (!cancelled) setSavedPlacePhotoUrls({});
        return;
      }
      // Rows are newest-first, so the first one seen per place is the one loadPhoto would also
      // pick as "the" photo for that place.
      const pathByPlaceId = new Map<string, string>();
      for (const row of rows) {
        if (!pathByPlaceId.has(row.saved_place_id)) {
          pathByPlaceId.set(row.saved_place_id, row.storage_path);
        }
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
      if (!cancelled) setSavedPlacePhotoUrls(urlByPlaceId);
    })();
    return () => {
      cancelled = true;
    };
  }, [savedPlaces]);

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

  // Notes has no "Done"/save button of its own — everything else in edit mode (photos, pin) saves
  // itself the moment it changes, so leaving edit mode (by either route below) is the one
  // remaining point that needs to flush the notes text field before it's gone. Returns false (and
  // leaves an error visible) if the save failed, so the caller can decide not to navigate away.
  const saveNotesIfChanged = async (): Promise<boolean> => {
    if (!selectedSavedPlace || notes === (selectedSavedPlace.notes ?? '')) return true;
    setSavingNotes(true);
    setNotesError(null);
    const nextNotes = notes.trim() ? notes : null;
    const { error } = await supabase
      .from('saved_places')
      .update({ notes: nextNotes })
      .eq('id', selectedSavedPlace.id);
    setSavingNotes(false);
    if (error) {
      setNotesError(error.message);
      return false;
    }
    onPlaceUpdated({ ...selectedSavedPlace, notes: nextNotes });
    return true;
  };

  // The header's top-left icon while viewing a place — closes the panel entirely (back to the
  // Welcome/list screen).
  const handleClose = async () => {
    if (savingNotes) return;
    if (await saveNotesIfChanged()) onBack();
  };

  // The same icon while editing (rendered as "‹" instead of "✕") — leaves edit mode but keeps the
  // same place open, rather than leaving the panel altogether.
  const handleExitEditing = async () => {
    if (savingNotes) return;
    if (await saveNotesIfChanged()) onExitEditing();
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
    const remainingSlots = MAX_PHOTOS - photos.length;
    if (remainingSlots <= 0) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setUploadError('Photo library access is required to add photos.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
    });
    if (result.canceled) return;
    setUploadingPhoto(true);
    setUploadError(null);
    const userId = session.user.id;
    const placeId = selectedSavedPlace.id;
    // A thumbnail is only generated for the very first photo this place has ever had, since that's
    // the one that becomes the default pin (see effectivePinPhotoId) — every later upload just
    // joins the gallery with thumbnail_path left null until/unless it's explicitly pinned (see
    // handleSetPinPhoto), rather than paying the resize/upload cost for photos that will likely
    // never render as a pin.
    const placeHadNoPhotos = photos.length === 0;
    for (const [index, asset] of result.assets.entries()) {
      let uploadUri = asset.uri;
      let contentType = asset.mimeType ?? 'image/jpeg';
      const longerSide = Math.max(asset.width, asset.height);
      if (longerSide > MAX_PHOTO_DIMENSION) {
        const scale = MAX_PHOTO_DIMENSION / longerSide;
        const context = ImageManipulator.manipulate(asset.uri);
        context.resize({
          width: Math.round(asset.width * scale),
          height: Math.round(asset.height * scale),
        });
        const rendered = await context.renderAsync();
        const resized = await rendered.saveAsync({
          format: SaveFormat.JPEG,
          compress: PHOTO_COMPRESSION_QUALITY,
        });
        uploadUri = resized.uri;
        contentType = 'image/jpeg';
      }

      const arrayBuffer = await fetch(uploadUri).then((res) => res.arrayBuffer());
      const extension = contentType === 'image/jpeg' ? 'jpg' : (uploadUri.split('.').pop() ?? 'jpg');
      // A random suffix (not just Date.now()) keeps paths unique when uploading several photos
      // from this same loop in quick succession, which can land in the same millisecond. The
      // thumbnail (when generated) shares that same suffix, filed under its own subfolder rather
      // than a filename variant, so it's obvious at a glance in storage which thumbnail belongs to
      // which photo.
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const path = `${userId}/${placeId}/${suffix}.${extension}`;
      const { error: uploadErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(path, arrayBuffer, { contentType });
      if (uploadErr) {
        setUploadingPhoto(false);
        setUploadError(uploadErr.message);
        setPhotos(await loadPhotos(placeId));
        return;
      }

      let thumbnailPath: string | null = null;
      if (placeHadNoPhotos && index === 0) {
        const thumbUri = await createPinThumbnailUri(asset.uri);
        const thumbArrayBuffer = await fetch(thumbUri).then((res) => res.arrayBuffer());
        thumbnailPath = `${userId}/${placeId}/thumbnails/${suffix}.jpg`;
        const { error: thumbUploadErr } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(thumbnailPath, thumbArrayBuffer, { contentType: 'image/jpeg' });
        if (thumbUploadErr) {
          setUploadingPhoto(false);
          setUploadError(thumbUploadErr.message);
          setPhotos(await loadPhotos(placeId));
          return;
        }
      }

      const { error: insertErr } = await supabase.from('saved_place_photos').insert({
        saved_place_id: placeId,
        user_id: userId,
        storage_path: path,
        thumbnail_path: thumbnailPath,
      });
      if (insertErr) {
        setUploadingPhoto(false);
        setUploadError(insertErr.message);
        setPhotos(await loadPhotos(placeId));
        return;
      }
    }
    const loaded = await loadPhotos(placeId);
    setUploadingPhoto(false);
    setPhotos(loaded);
    // The list-view thumbnail (savedPlacePhotoUrls) always shows the most recently uploaded photo
    // for a place, matching the "newest first" ordering that effect's own query uses.
    const latest = loaded[loaded.length - 1];
    if (latest) {
      setSavedPlacePhotoUrls((prev) => ({ ...prev, [placeId]: latest.url }));
    }
    // HomeScreen resolves each place's globe-pin photo (thumbnail-or-earliest-upload) in an effect
    // keyed on its own `savedPlaces` state, which nothing else here touches — without this, a
    // place's first-ever photo (which just became its default pin) would upload successfully but
    // the globe pin would keep showing the emoji fallback until something unrelated happened to
    // change savedPlaces. Handing back a fresh copy of the same place is enough to make that effect
    // re-run and pick up the new photo, even though pin_photo_id itself hasn't changed.
    if (selectedSavedPlace) onPlaceUpdated({ ...selectedSavedPlace });
  };

  const handleDeletePhoto = async () => {
    if (!confirmingDeletePhoto || deletingPhoto) return;
    setDeletingPhoto(true);
    setDeletePhotoError(null);
    const pathsToRemove = confirmingDeletePhoto.thumbnailPath
      ? [confirmingDeletePhoto.storagePath, confirmingDeletePhoto.thumbnailPath]
      : [confirmingDeletePhoto.storagePath];
    const { error: storageErr } = await supabase.storage.from(PHOTO_BUCKET).remove(pathsToRemove);
    if (storageErr) {
      setDeletingPhoto(false);
      setDeletePhotoError(storageErr.message);
      return;
    }
    const { error: deleteErr } = await supabase
      .from('saved_place_photos')
      .delete()
      .eq('id', confirmingDeletePhoto.id);
    setDeletingPhoto(false);
    if (deleteErr) {
      setDeletePhotoError(deleteErr.message);
      return;
    }
    const deletedId = confirmingDeletePhoto.id;
    setPhotos((prev) => prev.filter((photo) => photo.id !== deletedId));
    setConfirmingDeletePhoto(null);
    if (selectedSavedPlace && confirmingDeletePhoto.storagePath === photos[photos.length - 1]?.storagePath) {
      setSavedPlacePhotoUrls((prev) => {
        const next = { ...prev };
        const remaining = photos.filter((photo) => photo.id !== deletedId);
        const newLatest = remaining[remaining.length - 1];
        if (newLatest) next[selectedSavedPlace.id] = newLatest.url;
        else delete next[selectedSavedPlace.id];
        return next;
      });
    }
    // Always notify HomeScreen, even when pin_photo_id itself hasn't changed — deleting any photo
    // can shift which one is "the earliest-uploaded" (the fallback effectivePinPhotoId resolves to
    // when pin_photo_id is null), and HomeScreen only re-resolves the globe-pin photo when it sees
    // a new place object (see the matching comment in handleAddPhoto). The FK's `on delete set
    // null` already cleared pin_photo_id server-side when the deleted photo was the pinned one —
    // this just mirrors that locally so effectivePinPhotoId doesn't keep pointing at an id that no
    // longer exists until the next full reload.
    if (selectedSavedPlace) {
      const nextPinPhotoId = selectedSavedPlace.pin_photo_id === deletedId ? null : selectedSavedPlace.pin_photo_id;
      onPlaceUpdated({ ...selectedSavedPlace, pin_photo_id: nextPinPhotoId });
    }
  };

  const handleSetPinPhoto = async (photo: SavedPlacePhoto) => {
    if (!selectedSavedPlace || !session?.user || settingPinPhoto || effectivePinPhotoId === photo.id) {
      return;
    }
    setSettingPinPhoto(true);
    setPinPhotoError(null);
    // Thumbnails aren't generated for every gallery photo up front (see handleAddPhoto) — only the
    // place's first-ever upload gets one automatically, since that's the default pin. Explicitly
    // pinning a different photo is exactly the other case a thumbnail is needed for, so generate
    // one here on demand if this photo doesn't already have one.
    let thumbnailPath = photo.thumbnailPath;
    if (!thumbnailPath) {
      try {
        const blob = await fetch(photo.url).then((res) => res.blob());
        const dataUri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error('Failed to read photo'));
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
        const thumbUri = await createPinThumbnailUri(dataUri);
        const thumbArrayBuffer = await fetch(thumbUri).then((res) => res.arrayBuffer());
        const path = `${session.user.id}/${selectedSavedPlace.id}/thumbnails/${photo.id}.jpg`;
        const { error: thumbUploadErr } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(path, thumbArrayBuffer, { contentType: 'image/jpeg' });
        if (thumbUploadErr) throw new Error(thumbUploadErr.message);
        const { error: thumbUpdateErr } = await supabase
          .from('saved_place_photos')
          .update({ thumbnail_path: path })
          .eq('id', photo.id);
        if (thumbUpdateErr) throw new Error(thumbUpdateErr.message);
        thumbnailPath = path;
        setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, thumbnailPath: path } : p)));
      } catch (err) {
        setSettingPinPhoto(false);
        setPinPhotoError(err instanceof Error ? err.message : 'Failed to generate pin thumbnail.');
        return;
      }
    }
    // Picking a gallery photo as the pin supersedes any standalone pin image that was previously
    // set via handleEditPin — only one source is ever active at a time (see effectivePinPhotoId).
    const previousPinThumbnailPath = selectedSavedPlace.pin_thumbnail_path;
    const { error } = await supabase
      .from('saved_places')
      .update({ pin_photo_id: photo.id, pin_thumbnail_path: null })
      .eq('id', selectedSavedPlace.id);
    setSettingPinPhoto(false);
    if (error) {
      setPinPhotoError(error.message);
      return;
    }
    if (previousPinThumbnailPath) {
      await supabase.storage.from(PHOTO_BUCKET).remove([previousPinThumbnailPath]);
    }
    onPlaceUpdated({ ...selectedSavedPlace, pin_photo_id: photo.id, pin_thumbnail_path: null });
  };

  const handleEditPin = async () => {
    if (!selectedSavedPlace || !session?.user || editingPin) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setEditPinError('Photo library access is required to edit the pin.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (result.canceled) return;
    setEditingPin(true);
    setEditPinError(null);
    const userId = session.user.id;
    const placeId = selectedSavedPlace.id;
    // Setting a standalone pin image supersedes whichever gallery photo was previously pinned —
    // only one source is ever active at a time (see effectivePinPhotoId) — and, if this replaces an
    // earlier standalone pin, that old thumbnail file is now orphaned and gets cleaned up below.
    const previousPinThumbnailPath = selectedSavedPlace.pin_thumbnail_path;
    try {
      const asset = result.assets[0];
      const thumbUri = await createPinThumbnailUri(asset.uri);
      const thumbArrayBuffer = await fetch(thumbUri).then((res) => res.arrayBuffer());
      const path = `${userId}/${placeId}/thumbnails/pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error: uploadErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(path, thumbArrayBuffer, { contentType: 'image/jpeg' });
      if (uploadErr) throw new Error(uploadErr.message);
      const { error: updateErr } = await supabase
        .from('saved_places')
        .update({ pin_thumbnail_path: path, pin_photo_id: null })
        .eq('id', placeId);
      if (updateErr) throw new Error(updateErr.message);
      if (previousPinThumbnailPath) {
        await supabase.storage.from(PHOTO_BUCKET).remove([previousPinThumbnailPath]);
      }
      onPlaceUpdated({ ...selectedSavedPlace, pin_thumbnail_path: path, pin_photo_id: null });
    } catch (err) {
      setEditPinError(err instanceof Error ? err.message : 'Failed to update pin.');
    } finally {
      setEditingPin(false);
    }
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
            <Pressable
              onPress={isEditing ? handleExitEditing : handleClose}
              disabled={savingNotes}
              style={styles.headerCloseButton}
              hitSlop={8}
            >
              {savingNotes ? (
                <ActivityIndicator size="small" color={colors.inkSoft} />
              ) : (
                <Text style={styles.headerCloseButtonIcon}>{isEditing ? '‹' : '✕'}</Text>
              )}
            </Pressable>
          ) : (
            <View style={styles.headerCloseButtonSpacer} />
          )}
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {/* A plain spacer, always — the edit toggle moved out of this header entirely into a
              floating FAB next to the add-place one (see HomeScreen.tsx), so both sides of this
              row are now the same fixed 36pt width whenever the left shows a real button, keeping
              the title's flex:1 box (and the centered text inside it) symmetric. */}
          <View style={styles.headerCloseButtonSpacer} />
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

            {photos.length > 0 ? (
              <View style={styles.photoGrid}>
                {getPhotoGridRows(photos).map((row, rowIndex) => (
                  <View key={rowIndex} style={styles.photoGridRow}>
                    {row.map((photo, cellIndex) =>
                      photo ? (
                        <View key={photo.id} style={styles.photoGridCell}>
                          <Image
                            source={{ uri: photo.url }}
                            style={styles.photoGridImage}
                            resizeMode="cover"
                          />
                          {isEditing ? (
                            <Pressable
                              onPress={() => setConfirmingDeletePhoto(photo)}
                              style={styles.photoDeleteButton}
                              hitSlop={8}
                            >
                              <Text style={styles.photoDeleteButtonLabel}>×</Text>
                            </Pressable>
                          ) : null}
                          {isEditing && photos.length > 1 ? (
                            <Pressable
                              onPress={() => handleSetPinPhoto(photo)}
                              disabled={settingPinPhoto}
                              style={styles.photoPinButton}
                              hitSlop={8}
                            >
                              <Text
                                style={[
                                  styles.photoPinButtonLabel,
                                  photo.id !== effectivePinPhotoId && styles.photoPinButtonLabelInactive,
                                ]}
                              >
                                📌
                              </Text>
                            </Pressable>
                          ) : null}
                        </View>
                      ) : (
                        <View key={cellIndex} style={[styles.photoGridCell, styles.photoGridCellEmpty]} />
                      )
                    )}
                  </View>
                ))}
              </View>
            ) : null}

            {pinPhotoError ? <Text style={styles.searchError}>{pinPhotoError}</Text> : null}

            {isEditing ? (
              <>
                <Pressable
                  onPress={handleAddPhoto}
                  disabled={uploadingPhoto || photos.length >= MAX_PHOTOS}
                  style={({ pressed }) => [
                    styles.mapsButton,
                    pressed && styles.mapsButtonPressed,
                    (uploadingPhoto || photos.length >= MAX_PHOTOS) && styles.addPlaceButtonDisabled,
                  ]}
                >
                  {uploadingPhoto ? (
                    <ActivityIndicator color={colors.inkSoft} />
                  ) : (
                    <Text style={styles.mapsButtonLabel}>Add photos</Text>
                  )}
                </Pressable>

                {uploadError ? <Text style={styles.searchError}>{uploadError}</Text> : null}

                <View style={styles.pinRow}>
                  <View style={styles.pinShapeOuter}>
                    <View style={styles.pinShapeInner}>
                      {pinPreviewUrl ? (
                        <Image
                          source={{ uri: pinPreviewUrl }}
                          style={styles.pinShapeImage}
                          resizeMode="cover"
                        />
                      ) : (
                        <Text style={styles.pinShapeEmoji}>{emojiForPlaceId(selectedSavedPlace.id)}</Text>
                      )}
                    </View>
                  </View>
                  <Pressable
                    onPress={handleEditPin}
                    disabled={editingPin}
                    style={({ pressed }) => [
                      styles.editPinButton,
                      pressed && styles.mapsButtonPressed,
                      editingPin && styles.addPlaceButtonDisabled,
                    ]}
                  >
                    {editingPin ? (
                      <ActivityIndicator color={colors.inkSoft} />
                    ) : (
                      <Text style={styles.mapsButtonLabel}>Edit pin</Text>
                    )}
                  </Pressable>
                </View>

                {editPinError ? <Text style={styles.searchError}>{editPinError}</Text> : null}
              </>
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
              <Text style={styles.notesText}>{notes}</Text>
            ) : null}

            {notesError ? <Text style={styles.searchError}>{notesError}</Text> : null}

            {isEditing ? (
              <Pressable
                onPress={() => setConfirmingDelete(true)}
                style={({ pressed }) => [
                  styles.mapsButton,
                  styles.deleteButton,
                  pressed && styles.mapsButtonPressed,
                ]}
              >
                <Text style={[styles.mapsButtonLabel, styles.deleteButtonLabel]}>Delete place</Text>
              </Pressable>
            ) : null}
          </>
        ) : savedPlacesLoading ? (
          <ActivityIndicator color={colors.inkSoft} style={styles.searchStatus} />
        ) : savedPlacesError ? (
          <Text style={styles.searchError}>{savedPlacesError}</Text>
        ) : savedPlaces.length > 0 ? (
          <View style={styles.savedPlaceList}>
            {savedPlaces.map((place) => (
              <Pressable
                key={place.id}
                onPress={() => onSelectPlace(place)}
                style={({ pressed }) => [
                  styles.savedPlaceCard,
                  pressed && styles.savedPlaceCardPressed,
                ]}
              >
                {savedPlacePhotoUrls[place.id] ? (
                  <Image
                    source={{ uri: savedPlacePhotoUrls[place.id] }}
                    style={styles.savedPlacePhoto}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.savedPlaceEmoji}>
                    <Text style={styles.savedPlaceEmojiText}>{emojiForPlaceId(place.id)}</Text>
                  </View>
                )}
                <View style={styles.savedPlaceTextGroup}>
                  <Text style={styles.resultName} numberOfLines={1}>
                    {place.name}
                  </Text>
                  {place.category || place.formatted_address ? (
                    <Text style={styles.resultAddress} numberOfLines={3}>
                      {[place.category, place.formatted_address].filter(Boolean).join(' · ')}
                    </Text>
                  ) : null}
                </View>
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

      <Modal
        visible={!!confirmingDeletePhoto}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmingDeletePhoto(null)}
      >
        <View style={styles.confirmBackdrop}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmMessage}>Would you like to remove this photo?</Text>
            {deletePhotoError ? <Text style={styles.searchError}>{deletePhotoError}</Text> : null}
            <View style={styles.confirmButtonRow}>
              <Pressable
                onPress={() => setConfirmingDeletePhoto(null)}
                disabled={deletingPhoto}
                style={({ pressed }) => [styles.confirmButton, pressed && styles.mapsButtonPressed]}
              >
                <Text style={styles.mapsButtonLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleDeletePhoto}
                disabled={deletingPhoto}
                style={({ pressed }) => [
                  styles.confirmButton,
                  styles.confirmDeleteButton,
                  pressed && styles.mapsButtonPressed,
                  deletingPhoto && styles.addPlaceButtonDisabled,
                ]}
              >
                {deletingPhoto ? (
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
  // Circular, matching every other small icon button in the app (SettingsPanel's own close
  // button, the photo grid's delete/pin buttons) — the edit toggle used to sit on the opposite
  // side as a wider pill, which the close button was briefly widened to match, but it's since
  // moved out of this header into its own floating FAB, so there's no more asymmetry to match.
  headerCloseButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Mirrors headerCloseButton's footprint on the opposite side whenever it renders, so the
  // title's flex:1 box — and the centered text inside it — stays symmetric between two equal-width
  // slots rather than one real button and nothing at all.
  headerCloseButtonSpacer: {
    width: 36,
    height: 36,
  },
  // Same glyph/font/size/color as SettingsPanel.tsx's own closeIcon, for a consistent "close this
  // sheet" icon across the app.
  headerCloseButtonIcon: {
    fontFamily: fonts.bodyMedium,
    fontSize: 16,
    color: colors.inkSoft,
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
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  // A one-piece teardrop/map-pin shape via three rounded corners + a square one, rotated -45deg —
  // matches the pin shape traced in globe-entry.js's traceTeardropPath without needing an SVG
  // library. The image/emoji inside is counter-rotated back to upright so it renders correctly
  // clipped by the shape rather than rotated along with it, mirroring how the globe's canvas
  // rendering keeps the photo upright while clipping it to the same outline (see drawSavedPlacePins
  // in globe-entry.js).
  pinShapeOuter: {
    width: PIN_SHAPE_SIZE,
    height: PIN_SHAPE_SIZE,
    borderTopLeftRadius: PIN_SHAPE_SIZE / 2,
    borderTopRightRadius: PIN_SHAPE_SIZE / 2,
    borderBottomRightRadius: PIN_SHAPE_SIZE / 2,
    borderBottomLeftRadius: 0,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.panelBackground,
    overflow: 'hidden',
    transform: [{ rotate: '-45deg' }],
  },
  pinShapeInner: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
  },
  pinShapeImage: {
    width: '100%',
    height: '100%',
  },
  // Same 0.55 ratio as globe-entry.js's own PIN_FONT sizing, so the emoji fallback reads at the
  // same relative size as it does on the actual globe pin.
  pinShapeEmoji: {
    fontSize: Math.round(PIN_SHAPE_SIZE * 0.55),
  },
  editPinButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoGrid: {
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  photoGridRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  // flex: 1 with its own aspectRatio (rather than a fixed aspect ratio on the outer photoGrid,
  // shared out via flex among however many rows/cells exist) — each cell is always a true square,
  // so the grid's overall footprint grows with photo count instead of staying fixed. A rejected
  // earlier attempt fixed the outer container's aspect ratio to keep footprint constant across
  // counts (LEY-42); that's explicitly not what LEY-50 wants.
  photoGridCell: {
    flex: 1,
    aspectRatio: 1,
    position: 'relative',
  },
  photoGridCellEmpty: {
    backgroundColor: colors.panelBackground,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderStyle: 'dashed',
    borderRadius: radii.md,
  },
  photoGridImage: {
    width: '100%',
    height: '100%',
    borderRadius: radii.md,
    backgroundColor: colors.panelBackground,
  },
  photoDeleteButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoDeleteButtonLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    lineHeight: 16,
    color: colors.inkSoft,
  },
  photoPinButton: {
    position: 'absolute',
    bottom: -6,
    left: -6,
    width: 24,
    height: 24,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPinButtonLabel: {
    fontSize: 12,
  },
  photoPinButtonLabelInactive: {
    opacity: 0.35,
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
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.md,
    backgroundColor: colors.panelBackground,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },
  notesText: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
    textAlign: 'left',
    marginBottom: spacing.md,
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
  savedPlaceList: {
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  savedPlaceCard: {
    flexDirection: 'row',
    alignItems: 'stretch',
    height: SAVED_PLACE_CARD_HEIGHT,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  savedPlaceCardPressed: {
    backgroundColor: colors.panelBackground,
  },
  savedPlacePhoto: {
    width: 88,
    backgroundColor: colors.panelBackground,
  },
  savedPlaceEmoji: {
    width: 88,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.panelBackground,
  },
  savedPlaceEmojiText: {
    fontSize: 32,
  },
  savedPlaceTextGroup: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.sm,
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
