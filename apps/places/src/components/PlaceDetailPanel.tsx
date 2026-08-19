import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Linking,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, fonts, radii, spacing, TextField } from '@ley/ui';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const DISMISS_DRAG_THRESHOLD = 100;
const DISMISS_VELOCITY_THRESHOLD = 0.5;
const SPRING_CONFIG = { damping: 18, mass: 0.9, stiffness: 160, useNativeDriver: true } as const;

const GALLERY_PLACEHOLDERS = [colors.skyBlue, colors.sageGreen, colors.skyBlue, colors.sageGreen];
const GALLERY_ROWS = [GALLERY_PLACEHOLDERS.slice(0, 2), GALLERY_PLACEHOLDERS.slice(2, 4)];

type Props = {
  visible: boolean;
  onClose: () => void;
  location: { lat: number; lon: number } | null;
};

export function PlaceDetailPanel({ visible, onClose, location }: Props) {
  const [translateY] = useState(() => new Animated.Value(SCREEN_HEIGHT));
  const dragStartY = useRef(0);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    Animated.spring(translateY, { ...SPRING_CONFIG, toValue: visible ? 0 : SCREEN_HEIGHT }).start();
  }, [visible, translateY]);

  // dragStartY is only ever read/written inside these handlers (grant/move), never during
  // render — the rule can't see that the closure is deferred, hence the suppression.
  // eslint-disable-next-line react-hooks/refs
  const [panResponder] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderGrant: () => {
        translateY.stopAnimation((value) => {
          dragStartY.current = value;
        });
      },
      onPanResponderMove: (_, gesture) => {
        translateY.setValue(Math.max(0, dragStartY.current + gesture.dy));
      },
      onPanResponderRelease: (_, gesture) => {
        const shouldDismiss =
          gesture.dy > DISMISS_DRAG_THRESHOLD || gesture.vy > DISMISS_VELOCITY_THRESHOLD;
        if (shouldDismiss) {
          onClose();
        } else {
          Animated.spring(translateY, { ...SPRING_CONFIG, toValue: 0 }).start();
        }
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
      style={[styles.panel, { transform: [{ translateY }] }]}
    >
      <View {...panResponder.panHandlers}>
        <View style={styles.handle} />
        <View style={styles.headerRow}>
          <Text style={styles.title}>Dropped Pin</Text>
        </View>
      </View>

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

      <TextField
        label="Notes"
        placeholder="Add a note about this place…"
        value={notes}
        onChangeText={setNotes}
        multiline
        style={styles.notesInput}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 25,
    right: 25,
    bottom: 0,
    maxHeight: '58%',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    shadowColor: '#1D2620',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -3 },
    elevation: 3,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.hairline,
    marginBottom: spacing.md,
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
    minHeight: 80,
    textAlignVertical: 'top',
    textAlign: 'left',
    borderWidth: 0,
    paddingHorizontal: 0,
  },
});
