import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  BODY_IDS,
  BODY_COLORS,
  BODY_LABELS,
  BODY_SYMBOLS,
  LINE_KIND_LABELS,
  eclipticLonToSign,
} from '../lib/astro/bodies';
import { LINE_DESCRIPTIONS } from '../lib/astro/lineDescriptions';
import { BodyId, HouseChart, LineKind, NatalChart } from '../lib/astro/types';
import { formatCoords } from '../lib/formatCoords';
import { colors, fonts, radii, spacing } from '../theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  natalChart: NatalChart;
  houseChart: HouseChart | null;
  selectedLine: { bodyId: BodyId; kind: LineKind } | null;
};

export function RelocatedChartPanel({ visible, onClose, natalChart, houseChart, selectedLine }: Props) {
  const translateY = useRef(new Animated.Value(400)).current;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue: visible ? 0 : 400,
      useNativeDriver: true,
      damping: 18,
      mass: 0.9,
      stiffness: 160,
    }).start();
  }, [visible, translateY]);

  if (!houseChart && !selectedLine) return null;

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.panel, { transform: [{ translateY }] }]}
    >
      <View style={styles.handle} />
      {selectedLine ? (
        <LineContent selectedLine={selectedLine} onClose={onClose} />
      ) : houseChart ? (
        <LocationContent natalChart={natalChart} houseChart={houseChart} onClose={onClose} />
      ) : null}
    </Animated.View>
  );
}

function LineContent({
  selectedLine,
  onClose,
}: {
  selectedLine: { bodyId: BodyId; kind: LineKind };
  onClose: () => void;
}) {
  const { bodyId, kind } = selectedLine;
  return (
    <>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>{LINE_KIND_LABELS[kind]} line</Text>
          <View style={styles.lineHeading}>
            <Text style={[styles.symbol, styles.lineSymbol, { color: BODY_COLORS[bodyId] }]}>
              {BODY_SYMBOLS[bodyId]}
            </Text>
            <Text style={styles.coords}>{BODY_LABELS[bodyId]}</Text>
          </View>
        </View>
        <Pressable onPress={onClose} hitSlop={12} style={styles.closeButton}>
          <Text style={styles.closeLabel}>Close</Text>
        </Pressable>
      </View>

      <Text style={styles.note}>{LINE_DESCRIPTIONS[bodyId][kind]}</Text>
    </>
  );
}

function LocationContent({
  natalChart,
  houseChart,
  onClose,
}: {
  natalChart: NatalChart;
  houseChart: HouseChart;
  onClose: () => void;
}) {
  const ascendant = eclipticLonToSign(houseChart.ascendantDeg);
  const midheaven = eclipticLonToSign(houseChart.midheavenDeg);

  return (
    <>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>Reading the sky from</Text>
          <Text style={styles.coords}>{formatCoords(houseChart.latitude, houseChart.longitude)}</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={12} style={styles.closeButton}>
          <Text style={styles.closeLabel}>Close</Text>
        </Pressable>
      </View>

      <Text style={styles.note}>
        The chart, recalculated as though viewed from this point on the map. Angles shift with
        location; placements don&apos;t.
      </Text>

      <View style={styles.anglesRow}>
        <View style={styles.angleCard}>
          <Text style={styles.angleLabel}>Rising</Text>
          <Text style={styles.angleValue}>
            {ascendant.sign} {ascendant.degreeInSign.toFixed(1)}°
          </Text>
        </View>
        <View style={styles.angleCard}>
          <Text style={styles.angleLabel}>Midheaven</Text>
          <Text style={styles.angleValue}>
            {midheaven.sign} {midheaven.degreeInSign.toFixed(1)}°
          </Text>
        </View>
      </View>

      <ScrollView style={styles.bodyList} showsVerticalScrollIndicator={false}>
        {BODY_IDS.map((bodyId) => {
          const position = natalChart.positions.find((p) => p.bodyId === bodyId);
          if (!position) return null;
          const { sign, degreeInSign } = eclipticLonToSign(position.eclipticLonDeg);
          const house = houseChart.bodyHouses[bodyId];
          return (
            <View key={bodyId} style={styles.bodyRow}>
              <View style={styles.bodyLeft}>
                <Text style={[styles.symbol, { color: BODY_COLORS[bodyId] }]}>
                  {BODY_SYMBOLS[bodyId]}
                </Text>
                <Text style={styles.bodyName}>{BODY_LABELS[bodyId]}</Text>
              </View>
              <Text style={styles.bodyDetail}>
                {sign} {degreeInSign.toFixed(1)}° · house {house}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '52%',
    backgroundColor: colors.panelBackground,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    shadowColor: '#1D2620',
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 },
    elevation: 12,
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  eyebrow: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    color: colors.inkSoft,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  coords: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 22,
    color: colors.ink,
    marginTop: 2,
  },
  lineHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  lineSymbol: {
    fontSize: 20,
    width: undefined,
    marginTop: 2,
  },
  closeButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  closeLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    color: colors.inkSoft,
  },
  note: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.inkSoft,
    lineHeight: 18,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  anglesRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  angleCard: {
    flex: 1,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  angleLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    color: colors.inkSoft,
    marginBottom: 2,
  },
  angleValue: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 16,
    color: colors.ink,
  },
  bodyList: {
    flexGrow: 0,
  },
  bodyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  bodyLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  symbol: {
    fontSize: 16,
    width: 22,
    textAlign: 'center',
  },
  bodyName: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    color: colors.ink,
  },
  bodyDetail: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.inkSoft,
  },
});
