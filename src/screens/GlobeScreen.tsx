import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Globe } from '../components/Globe';
import { RelocatedChartPanel } from '../components/RelocatedChartPanel';
import { useAuth } from '../context/AuthContext';
import { computeAstroLines, computeHouseChart, computeNatalChart } from '../lib/astro';
import { HouseChart } from '../lib/astro/types';
import { BirthData } from '../types/birthData';
import { colors, fonts, spacing } from '../theme';

export function GlobeScreen({ birthData }: { birthData: BirthData }) {
  const { signOut } = useAuth();
  const [houseChart, setHouseChart] = useState<HouseChart | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);

  const natalChart = useMemo(() => computeNatalChart(new Date(birthData.birthUtc)), [birthData.birthUtc]);
  const astroLines = useMemo(() => computeAstroLines(natalChart), [natalChart]);

  const handleTapLocation = (lat: number, lon: number) => {
    setHouseChart(computeHouseChart(natalChart, lat, lon));
    setPanelVisible(true);
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
        <Text style={styles.hint}>Touch the globe to see how the chart reads from there.</Text>
      </SafeAreaView>

      <Globe lines={astroLines} onTapLocation={handleTapLocation} />

      <RelocatedChartPanel
        visible={panelVisible}
        onClose={() => setPanelVisible(false)}
        natalChart={natalChart}
        houseChart={houseChart}
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
