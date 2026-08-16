import * as Astronomy from 'astronomy-engine';
import { BODY_IDS } from './bodies';
import { BodyId, BodyPosition, NatalChart } from './types';

/**
 * Computes geocentric apparent positions (equator & ecliptic of date) for each
 * tracked body at the given UTC instant, plus sidereal time and obliquity —
 * everything astrocartography lines and house calculations are built from.
 */
export function computeNatalChart(utcDate: Date): NatalChart {
  const time = Astronomy.MakeTime(utcDate);
  const rotToEquatorOfDate = Astronomy.Rotation_EQJ_EQD(time);
  const rotToEclipticOfDate = Astronomy.Rotation_EQJ_ECT(time);

  const positions: BodyPosition[] = BODY_IDS.map((bodyId) => {
    const geoVectorJ2000 = Astronomy.GeoVector(Astronomy.Body[bodyId], time, true);

    const equatorialOfDate = Astronomy.EquatorFromVector(
      Astronomy.RotateVector(rotToEquatorOfDate, geoVectorJ2000)
    );
    const eclipticOfDate = Astronomy.SphereFromVector(
      Astronomy.RotateVector(rotToEclipticOfDate, geoVectorJ2000)
    );

    return {
      bodyId,
      raDeg: equatorialOfDate.ra * 15,
      decDeg: equatorialOfDate.dec,
      eclipticLonDeg: normalizeDegrees(eclipticOfDate.lon),
    };
  });

  const gastDeg = Astronomy.SiderealTime(time) * 15;
  const obliquityDeg = Astronomy.e_tilt(time).tobl;

  return {
    utcInstant: utcDate.toISOString(),
    gastDeg,
    obliquityDeg,
    positions,
  };
}

export function getPosition(chart: NatalChart, bodyId: BodyId): BodyPosition {
  const position = chart.positions.find((p) => p.bodyId === bodyId);
  if (!position) throw new Error(`Missing computed position for ${bodyId}`);
  return position;
}

export function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
