import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Linking,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, fonts, radii, spacing } from '@ley/ui';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
export const PANEL_PEEK_HEIGHT = SCREEN_HEIGHT / 3;
const SNAP_DRAG_THRESHOLD = 60;
const SNAP_VELOCITY_THRESHOLD = 0.5;
const SPRING_CONFIG = { damping: 18, mass: 0.9, stiffness: 160, useNativeDriver: true } as const;

const GALLERY_PLACEHOLDERS = [colors.skyBlue, colors.sageGreen, colors.skyBlue, colors.sageGreen];
const GALLERY_ROWS = [GALLERY_PLACEHOLDERS.slice(0, 2), GALLERY_PLACEHOLDERS.slice(2, 4)];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type Props = {
  visible: boolean;
  title: string;
  location: { lat: number; lon: number } | null;
  addingPlace: boolean;
};

export function PlaceDetailPanel({ visible, title, location, addingPlace }: Props) {
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

  const peekTranslateY = (height: number) => Math.max(0, height - PANEL_PEEK_HEIGHT);

  // A new tapped location, or entering the add-place flow, should always re-open the panel
  // fully, even if it was left peeked from before — adjusted during render (React's recommended
  // pattern for state that depends on a prop change) rather than an effect, since setState-in-
  // effect on every mount triggers a needless extra render.
  const [prevLocation, setPrevLocation] = useState(location);
  if (location !== prevLocation) {
    setPrevLocation(location);
    if (location && !expanded) setExpanded(true);
  }

  const [prevAddingPlace, setPrevAddingPlace] = useState(addingPlace);
  if (addingPlace !== prevAddingPlace) {
    setPrevAddingPlace(addingPlace);
    if (addingPlace && !expanded) setExpanded(true);
  }

  useEffect(() => {
    const target = !visible ? SCREEN_HEIGHT : expanded ? 0 : peekTranslateY(panelHeightMeasured);
    Animated.spring(translateY, { ...SPRING_CONFIG, toValue: target }).start();
  }, [visible, expanded, panelHeightMeasured, translateY]);

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
    if (!location) return;
    Linking.openURL(`https://maps.apple.com/?ll=${location.lat},${location.lon}`);
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
          <Text style={styles.title}>{title}</Text>
        </View>
      </View>

      {addingPlace ? (
        <TextInput
          placeholder="Search for a place…"
          placeholderTextColor={colors.inkSoft}
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={styles.searchInput}
        />
      ) : location ? (
        <>
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
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 15,
    right: 15,
    bottom: 0,
    maxHeight: '58%',
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
  title: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 22,
    color: colors.ink,
    textAlign: 'center',
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
});
