// Small, pure spherical-geometry helpers shared across the city-label modules. Kept separate from
// globe-entry.js so these modules don't depend on the entry file — the dependency runs the other
// way, entry imports from here.

// Great-circle angular distance between two [lon, lat] points, in degrees. Same law-of-cosines
// formula used for isFrontFacing/cullByBbox in globe-entry.js.
export function angularDistanceDeg(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const cosc = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos((lon2 - lon1) * toRad);
  return (Math.acos(clamp(cosc, -1, 1)) * 180) / Math.PI;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Whether [lon, lat] currently faces the viewer, given the look-at point [lookLon, lookLat]
// (globe-entry.js's own isFrontFacing is a closure over its module-level `rotation` — this is the
// same math with the look-at point passed explicitly instead, so it doesn't need that closure).
export function isFrontFacing(lon, lat, lookLon, lookLat) {
  return angularDistanceDeg(lon, lat, lookLon, lookLat) < 90;
}

// The farthest angular distance from the look-at point that can possibly land inside a
// width x height canvas at the given baseScale/zoom — see cullByBbox/visibleCapRadiusDeg in
// globe-entry.js for the original reasoning (this is the same formula, parameterized). Once the
// canvas already shows the whole front hemisphere (halfDiagonal >= radius), this returns 90 and
// there's nothing to gain from filtering by it.
export function visibleCapRadiusDeg(width, height, baseScale, zoom) {
  const halfDiagonal = Math.sqrt((width / 2) ** 2 + (height / 2) ** 2);
  const radius = baseScale * zoom;
  if (halfDiagonal >= radius) return 90;
  return (Math.asin(Math.min(1, halfDiagonal / radius)) * 180) / Math.PI;
}
