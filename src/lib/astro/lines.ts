import { BODY_COLORS, BODY_IDS } from './bodies';
import { AstroLine, LonLat, NatalChart } from './types';

const LAT_MIN = -85;
const LAT_MAX = 85;
const LAT_STEP = 1;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function normalizeLon(deg: number): number {
  return (((deg + 180) % 360) + 360) % 360 - 180;
}

function latitudeSamples(): number[] {
  const samples: number[] = [];
  for (let lat = LAT_MIN; lat <= LAT_MAX + 1e-9; lat += LAT_STEP) {
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
 *     satisfies cos(H) = -tan(φ) * tan(δ); H0 = acos(...) in [0, 180].
 *     Rising (AC): longitude = RA - GAST - H0.  Setting (DC): longitude = RA - GAST + H0.
 *     No solution exists where |tan(φ) * tan(δ)| > 1 (the body is circumpolar or never
 *     rises there), which breaks the line into segments.
 */
export function computeAstroLines(chart: NatalChart): AstroLine[] {
  const lats = latitudeSamples();
  const lines: AstroLine[] = [];

  for (const bodyId of BODY_IDS) {
    const position = chart.positions.find((p) => p.bodyId === bodyId);
    if (!position) continue;

    const color = BODY_COLORS[bodyId];
    const baseLon = position.raDeg - chart.gastDeg;
    const decRad = position.decDeg * DEG2RAD;
    const tanDec = Math.tan(decRad);

    const mcLon = normalizeLon(baseLon);
    const icLon = normalizeLon(baseLon + 180);

    const mcSegment: LonLat[] = lats.map((lat) => [mcLon, lat]);
    const icSegment: LonLat[] = lats.map((lat) => [icLon, lat]);

    const acSegments: LonLat[][] = [];
    const dcSegments: LonLat[][] = [];
    let acCurrent: LonLat[] = [];
    let dcCurrent: LonLat[] = [];

    for (const lat of lats) {
      const tanLat = Math.tan(lat * DEG2RAD);
      const cosH = -tanLat * tanDec;

      if (cosH < -1 || cosH > 1) {
        if (acCurrent.length > 1) acSegments.push(acCurrent);
        if (dcCurrent.length > 1) dcSegments.push(dcCurrent);
        acCurrent = [];
        dcCurrent = [];
        continue;
      }

      const h0 = Math.acos(cosH) * RAD2DEG;
      acCurrent.push([normalizeLon(baseLon - h0), lat]);
      dcCurrent.push([normalizeLon(baseLon + h0), lat]);
    }
    if (acCurrent.length > 1) acSegments.push(acCurrent);
    if (dcCurrent.length > 1) dcSegments.push(dcCurrent);

    lines.push({ bodyId, kind: 'MC', color, segments: [mcSegment] });
    lines.push({ bodyId, kind: 'IC', color, segments: [icSegment] });
    lines.push({ bodyId, kind: 'AC', color, segments: splitOnAntimeridianJump(acSegments) });
    lines.push({ bodyId, kind: 'DC', color, segments: splitOnAntimeridianJump(dcSegments) });
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
