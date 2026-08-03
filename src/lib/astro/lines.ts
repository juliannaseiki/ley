import { BODY_COLORS, BODY_IDS } from './bodies';
import { AstroLine, LonLat, NatalChart } from './types';

// MC/IC lines have no singularity, so they're densely sampled all the way to the literal poles
// — d3's projection is numerically exact there (every meridian maps to the same pixel regardless
// of longitude), so this converges cleanly as long as the lines are drawn with round caps (see
// globe-entry.js) rather than flat ones.
const MERIDIAN_LAT_MIN = -90;
const MERIDIAN_LAT_MAX = 90;
const LAT_STEP = 1;
const H_STEP = 1;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function normalizeLon(deg: number): number {
  return (((deg + 180) % 360) + 360) % 360 - 180;
}

function sampleLatitudes(min: number, max: number): number[] {
  const samples: number[] = [];
  for (let lat = min; lat <= max + 1e-9; lat += LAT_STEP) {
    samples.push(Math.round(lat * 100) / 100);
  }
  return samples;
}

/**
 * Computes astrocartography lines: for each tracked body, the meridians where it
 * culminates (MC) / anti-culminates (IC), and the curves where it rises (AC) / sets (DC).
 *
 * Standard spherical-astronomy formulas, using the body's geocentric apparent right
 * ascension & declination of date, and Greenwich Apparent Sidereal Time (GAST):
 *   - MC longitude = RA - GAST (a full meridian, all latitudes)
 *   - IC longitude = MC longitude + 180
 *   - At geographic latitude φ, the body is on the horizon when the hour angle H
 *     satisfies cos(H) = -tan(φ) * tan(δ).
 *
 * AC/DC are parametrized by H directly (lat = atan(-cos(H) / tan(δ))) rather than by solving
 * for H at each sampled latitude. The two are mathematically equivalent, but H -> lat is smooth
 * and bounded for every H (atan's range is always within (-90, 90)), while lat -> H has an
 * unbounded derivative near the circumpolar limit — fixed-latitude sampling there produces huge
 * jumps in longitude between adjacent points, rendering as a jagged, broken-looking curve right
 * where it should sweep smoothly through the limit. H in (0, 180] traces the rising (AC) branch;
 * H in [-180, 0] traces the setting (DC) branch. Each sweeps the body's full valid latitude
 * range on its own, from one circumpolar limit through the equator to the other, with no need to
 * detect or break out of a circumpolar case at all.
 */
export function computeAstroLines(chart: NatalChart): AstroLine[] {
  const meridianLats = sampleLatitudes(MERIDIAN_LAT_MIN, MERIDIAN_LAT_MAX);
  const lines: AstroLine[] = [];

  for (const bodyId of BODY_IDS) {
    const position = chart.positions.find((p) => p.bodyId === bodyId);
    if (!position) continue;

    const color = BODY_COLORS[bodyId];
    const baseLon = position.raDeg - chart.gastDeg;
    const decRad = position.decDeg * DEG2RAD;
    const tanDec = Math.tan(decRad);
    // Guard the (extremely rare) instant a body sits exactly on the celestial equator, which
    // would otherwise divide by zero below.
    const safeTanDec = Math.abs(tanDec) < 1e-6 ? (tanDec < 0 ? -1e-6 : 1e-6) : tanDec;

    const mcLon = normalizeLon(baseLon);
    const icLon = normalizeLon(baseLon + 180);

    const mcSegment: LonLat[] = meridianLats.map((lat) => [mcLon, lat]);
    const icSegment: LonLat[] = meridianLats.map((lat) => [icLon, lat]);

    const acPoints: LonLat[] = [];
    const dcPoints: LonLat[] = [];
    for (let hDeg = -180 + H_STEP; hDeg <= 180; hDeg += H_STEP) {
      const lat = Math.atan(-Math.cos(hDeg * DEG2RAD) / safeTanDec) * RAD2DEG;
      const lon = normalizeLon(baseLon - hDeg);
      if (hDeg > 0) {
        acPoints.push([lon, lat]);
      } else {
        dcPoints.push([lon, lat]);
      }
    }

    lines.push({ bodyId, kind: 'MC', color, segments: [mcSegment] });
    lines.push({ bodyId, kind: 'IC', color, segments: [icSegment] });
    lines.push({ bodyId, kind: 'AC', color, segments: splitOnAntimeridianJump([acPoints]) });
    lines.push({ bodyId, kind: 'DC', color, segments: splitOnAntimeridianJump([dcPoints]) });
  }

  return lines;
}

/** Breaks a segment wherever consecutive points imply a >180deg jump, so wraparound at +/-180 renders as two segments instead of a spurious line straight across the map. */
function splitOnAntimeridianJump(segments: LonLat[][]): LonLat[][] {
  const result: LonLat[][] = [];
  for (const segment of segments) {
    let current: LonLat[] = [segment[0]];
    for (let i = 1; i < segment.length; i++) {
      const [prevLon] = segment[i - 1];
      const [lon] = segment[i];
      if (Math.abs(lon - prevLon) > 180) {
        if (current.length > 1) result.push(current);
        current = [segment[i]];
      } else {
        current.push(segment[i]);
      }
    }
    if (current.length > 1) result.push(current);
  }
  return result;
}
