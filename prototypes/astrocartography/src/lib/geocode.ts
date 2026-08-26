export type PlaceResult = {
  id: string;
  displayName: string;
  latitude: number;
  longitude: number;
};

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(trimmed)}&format=jsonv2&limit=6&addressdetails=0`;
  const response = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'LeyAstrocartographyApp/1.0 (contact: app-support@ley.app)',
      'Accept-Language': 'en',
    },
  });

  if (!response.ok) {
    throw new Error('Could not search for that location right now.');
  }

  const results = (await response.json()) as Array<{
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
  }>;

  return results.map((r) => ({
    id: String(r.place_id),
    displayName: r.display_name,
    latitude: parseFloat(r.lat),
    longitude: parseFloat(r.lon),
  }));
}
