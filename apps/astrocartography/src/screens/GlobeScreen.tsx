import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Globe } from '../components/Globe';
import { RelocatedChartPanel } from '../components/RelocatedChartPanel';
import { useAuth } from '@ley/auth';
import { colors, fonts, spacing } from '@ley/ui';
import { computeAstroLines, computeHouseChart, computeNatalChart } from '../lib/astro';
import { BodyId, HouseChart, LineKind } from '../lib/astro/types';
import { BirthData } from '../types/birthData';

export function GlobeScreen({ birthData }: { birthData: BirthData }) {
  const { signOut } = useAuth();
  const [houseChart, setHouseChart] = useState<HouseChart | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);
  const [pinLocation, setPinLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [selectedLine, setSelectedLine] = useState<{ bodyId: BodyId; kind: LineKind } | null>(null);

  const natalChart = useMemo(() => computeNatalChart(new Date(birthData.birthUtc)), [birthData.birthUtc]);
  const astroLines = useMemo(() => computeAstroLines(natalChart), [natalChart]);

  const handleTapLocation = (lat: number, lon: number) => {
    setSelectedLine(null);
    setHouseChart(computeHouseChart(natalChart, lat, lon));
    setPinLocation({ lat, lon });
    setPanelVisible(true);
  };

  const handleTapLine = (bodyId: BodyId, kind: LineKind) => {
    setSelectedLine({ bodyId, kind });
    setPanelVisible(true);
  };

  const handleClosePanel = () => {
    setPanelVisible(false);
    setPinLocation(null);
    setSelectedLine(null);
  };

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.headerSafe} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>Ley</Text>
          <Pressable onPress={() => signOut()} hitSlop={12}>
            <Text style={styles.signOut}>Log out</Text>
          </Pressable>
        </View>
      </SafeAreaView>

      <Globe
        lines={astroLines}
        pinLocation={pinLocation}
        onTapLocation={handleTapLocation}
        onTapLine={handleTapLine}
      />

      <RelocatedChartPanel
        visible={panelVisible}
        onClose={handleClosePanel}
        natalChart={natalChart}
        houseChart={houseChart}
        selectedLine={selectedLine}
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
  signOut: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    color: colors.inkSoft,
  },
  hint: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.inkSoft,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
});
