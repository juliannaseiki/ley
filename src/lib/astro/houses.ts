import { BodyId, HouseChart, NatalChart } from './types';
import { normalizeDegrees } from './ephemeris';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Computes the Ascendant, Midheaven, and whole-sign houses for a given location,
 * holding the birth instant fixed (this is what "relocating" a chart means).
 *
 * Standard spherical-astronomy formulas:
 *   RAMC = GAST + longitude (the right ascension currently on the local meridian)
 *   MC   = atan2(sin(RAMC), cos(RAMC) * cos(obliquity))
 *   ASC  = atan2(-cos(RAMC), sin(obliquity) * tan(latitude) + cos(obliquity) * sin(RAMC))
 *
 * Houses use the whole-sign system: house 1 is the entire zodiac sign containing the
 * Ascendant, and each subsequent house is the next sign in order. It's the simplest
 * house system to compute reliably at any latitude (no pole singularities), and one
 * of the oldest in use.
 */
export function computeHouseChart(chart: NatalChart, latitude: number, longitude: number): HouseChart {
  const obliquityRad = chart.obliquityDeg * DEG2RAD;
  const ramcDeg = normalizeDegrees(chart.gastDeg + longitude);
  const ramcRad = ramcDeg * DEG2RAD;
  const latRad = latitude * DEG2RAD;

  const midheavenDeg = normalizeDegrees(
    Math.atan2(Math.sin(ramcRad), Math.cos(ramcRad) * Math.cos(obliquityRad)) * RAD2DEG
  );

  const ascendantDeg = normalizeDegrees(
    Math.atan2(
      Math.cos(ramcRad),
      -(Math.sin(obliquityRad) * Math.tan(latRad) + Math.cos(obliquityRad) * Math.sin(ramcRad))
    ) * RAD2DEG
  );

  const houseOneCusp = Math.floor(ascendantDeg / 30) * 30;
  const houseCusps = Array.from({ length: 12 }, (_, i) => normalizeDegrees(houseOneCusp + i * 30));

  const bodyHouses = {} as Record<BodyId, number>;
  for (const position of chart.positions) {
    const offset = normalizeDegrees(position.eclipticLonDeg - houseOneCusp);
    bodyHouses[position.bodyId] = Math.floor(offset / 30) + 1;
  }

  return {
    latitude,
    longitude,
    ascendantDeg,
    midheavenDeg,
    houseCusps,
    bodyHouses,
  };
}
