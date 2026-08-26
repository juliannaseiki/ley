export type BodyId =
  | 'Sun'
  | 'Moon'
  | 'Mercury'
  | 'Venus'
  | 'Mars'
  | 'Jupiter'
  | 'Saturn'
  | 'Uranus'
  | 'Neptune'
  | 'Pluto';

export type LineKind = 'MC' | 'IC' | 'AC' | 'DC';

export type LonLat = [number, number];

export type AstroLine = {
  bodyId: BodyId;
  kind: LineKind;
  color: string;
  /** One or more contiguous [lon, lat] point sequences (segments can be broken by circumpolar gaps). */
  segments: LonLat[][];
};

/** Geocentric apparent position of a body at a given instant, equator/ecliptic of date. */
export type BodyPosition = {
  bodyId: BodyId;
  /** Right ascension in degrees [0, 360). */
  raDeg: number;
  /** Declination in degrees [-90, 90]. */
  decDeg: number;
  /** Ecliptic longitude of date, tropical, in degrees [0, 360). */
  eclipticLonDeg: number;
};

export type NatalChart = {
  utcInstant: string;
  /** Greenwich Apparent Sidereal Time in degrees [0, 360). */
  gastDeg: number;
  /** True obliquity of the ecliptic, in degrees. */
  obliquityDeg: number;
  positions: BodyPosition[];
};

export type HouseChart = {
  latitude: number;
  longitude: number;
  ascendantDeg: number;
  midheavenDeg: number;
  /** Whole-sign house cusps, index 0 = house 1 cusp, in ecliptic longitude degrees. */
  houseCusps: number[];
  /** Which whole-sign house (1-12) each body falls in. */
  bodyHouses: Record<BodyId, number>;
};
