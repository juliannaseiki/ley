const PLACES_SEARCH_URL = 'https://places-api.foursquare.com/places/search';

// Foursquare's current Places API is date-versioned — every request must pin a version.
const PLACES_API_VERSION = '2025-06-17';

export type PlaceSearchResult = {
  id: string;
  name: string;
  formattedAddress?: string;
  location?: { lat: number; lon: number };
  // Full per-place object as returned by the API, kept as-is so the UI can surface whatever
  // fields came back without this client needing to know about every one of them.
  raw: Record<string, unknown>;
};

export async function searchPlaces(query: string): Promise<PlaceSearchResult[]> {
  const apiKey = process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing EXPO_PUBLIC_FOURSQUARE_API_KEY. Copy .env.example to .env and fill in your Foursquare API key, then restart the dev server.'
    );
  }

  const url = `${PLACES_SEARCH_URL}?query=${encodeURIComponent(query)}&limit=10`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Places-Api-Version': PLACES_API_VERSION,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Foursquare search failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { results?: Record<string, unknown>[] };
  const results = data.results ?? [];

  return results.map((place) => {
    const location = place.location as { formatted_address?: string } | undefined;
    const lat = place.latitude as number | undefined;
    const lon = place.longitude as number | undefined;
    return {
      id: String(place.fsq_place_id ?? ''),
      name: String(place.name ?? 'Unnamed place'),
      formattedAddress: location?.formatted_address,
      location: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
      raw: place,
    };
  });
}
