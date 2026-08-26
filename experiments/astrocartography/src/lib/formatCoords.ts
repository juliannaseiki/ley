export function formatCoords(lat: number, lon: number): string {
  const latLabel = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonLabel = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latLabel}, ${lonLabel}`;
}
