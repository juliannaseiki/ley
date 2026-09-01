import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radii, spacing } from '@ley/ui';
import { supabase, useAuth } from '@ley/auth';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SPRING_CONFIG = { damping: 18, mass: 0.9, stiffness: 160, useNativeDriver: true } as const;
const FADE_DURATION_MS = 220;

type Props = {
  visible: boolean;
  onClose: () => void;
  onLogout: () => void;
};

// A plain RN Modal — its own native layer above everything else, so no zIndex coordination needed
// the way the header/FAB/panel needed for PlaceDetailPanel — but with animationType="none": RN's
// built-in slide/fade applies one animation to the whole modal at once, and the backdrop and sheet
// want different animations (fade vs. slide), so both are driven by hand instead. modalMounted
// lags one tick behind `visible` on close specifically so the closing animation has something to
// play before the native Modal actually unmounts — Modal's `visible` prop has no exit-animation
// hook of its own.
export function SettingsPanel({ visible, onClose, onLogout }: Props) {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const [modalMounted, setModalMounted] = useState(visible);
  const [backdropOpacity] = useState(() => new Animated.Value(0));
  const [sheetTranslateY] = useState(() => new Animated.Value(SCREEN_HEIGHT));
  const [name, setName] = useState('');
  const [initialName, setInitialName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Opening needs modalMounted true immediately (synchronously, so the Modal exists in time to
  // animate in) — adjusted during render, React's recommended pattern for state that depends on a
  // prop change, same as PlaceDetailPanel's prevSelectedSavedPlace/prevAddingPlace above. Closing
  // is the asymmetric case (below): it can't be synchronous, since modalMounted has to stay true
  // until the closing animation actually finishes.
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) setModalMounted(true);
  }

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 1, duration: FADE_DURATION_MS, useNativeDriver: true }),
        Animated.spring(sheetTranslateY, { ...SPRING_CONFIG, toValue: 0 }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 0, duration: FADE_DURATION_MS, useNativeDriver: true }),
        Animated.spring(sheetTranslateY, { ...SPRING_CONFIG, toValue: SCREEN_HEIGHT }),
      ]).start(() => setModalMounted(false));
    }
  }, [visible, backdropOpacity, sheetTranslateY]);

  useEffect(() => {
    if (!visible || !session?.user) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('name')
      .eq('id', session.user.id)
      .then(({ data }) => {
        if (cancelled) return;
        const fetchedName = data?.[0]?.name ?? '';
        setName(fetchedName);
        setInitialName(fetchedName);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, session?.user]);

  const handleLogout = () => {
    onClose();
    onLogout();
  };

  const handleSaveName = async () => {
    if (!session?.user || savingName) return;
    const trimmed = name.trim();
    setSavingName(true);
    setNameError(null);
    const { error } = await supabase
      .from('profiles')
      .upsert({ id: session.user.id, name: trimmed });
    setSavingName(false);
    if (error) {
      setNameError(error.message);
      return;
    }
    setName(trimmed);
    setInitialName(trimmed);
  };

  return (
    <Modal visible={modalMounted} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.backdropTouchable} onPress={onClose}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />
      </Pressable>
      <Animated.View
        style={[
          styles.sheet,
          {
            top: insets.top,
            paddingBottom: insets.bottom + spacing.lg,
            transform: [{ translateY: sheetTranslateY }],
          },
        ]}
      >
        <View style={styles.headerRow}>
          <Text style={styles.title}>Settings</Text>
          <Pressable onPress={onClose} style={styles.closeButton} hitSlop={12}>
            <Text style={styles.closeIcon}>✕</Text>
          </Pressable>
        </View>
        <View style={styles.nameSection}>
          <Text style={styles.nameLabel}>Name</Text>
          <TextInput
            placeholder="Add your name"
            placeholderTextColor={colors.inkSoft}
            value={name}
            onChangeText={setName}
            style={styles.nameInput}
          />
          {nameError ? <Text style={styles.nameError}>{nameError}</Text> : null}
          <Pressable
            onPress={handleSaveName}
            disabled={savingName || name.trim() === initialName}
            style={({ pressed }) => [
              styles.saveButton,
              pressed && styles.saveButtonPressed,
              (savingName || name.trim() === initialName) && styles.saveButtonDisabled,
            ]}
          >
            {savingName ? (
              <ActivityIndicator color={colors.inkSoft} />
            ) : (
              <Text style={styles.saveButtonLabel}>Save</Text>
            )}
          </Pressable>
        </View>
        <Pressable
          onPress={handleLogout}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        >
          <Text style={styles.rowLabel}>Log out</Text>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropTouchable: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(40, 49, 44, 0.3)',
  },
  sheet: {
    position: 'absolute',
    left: 15,
    right: 15,
    bottom: 0,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    shadowColor: '#1D2620',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -3 },
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  title: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 20,
    color: colors.ink,
    textAlign: 'center',
  },
  closeButton: {
    position: 'absolute',
    right: 0,
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIcon: {
    fontFamily: fonts.bodyMedium,
    fontSize: 16,
    color: colors.inkSoft,
  },
  row: {
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  rowPressed: {
    backgroundColor: colors.panelBackground,
  },
  rowLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: 16,
    color: colors.ink,
  },
  nameSection: {
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  nameLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    color: colors.inkSoft,
    marginBottom: spacing.xs,
  },
  nameInput: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    backgroundColor: colors.panelBackground,
    marginBottom: spacing.sm,
  },
  nameError: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.error,
    marginBottom: spacing.sm,
  },
  saveButton: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.pill,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonPressed: {
    backgroundColor: colors.hairline,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    color: colors.ink,
  },
});
