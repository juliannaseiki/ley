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

async function runSearch(url: string, apiKey: string): Promise<Record<string, unknown>[]> {
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
  return data.results ?? [];
}

function toPlaceSearchResult(place: Record<string, unknown>): PlaceSearchResult {
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
}

// Foursquare has no unbiased global text search — every endpoint (search, autocomplete) anchors
// to a location, defaulting to the device's IP-inferred position within ~22km when neither `ll`
// nor `near` is given. So "name, city" is treated as two parts: the name searched via `query`,
// the city geocoded via `near` — letting you find a specific known venue anywhere in the world by
// naming its city, rather than only ever matching what's near you right now.
function splitNameAndLocation(query: string): { name: string; near?: string } {
  const lastComma = query.lastIndexOf(',');
  if (lastComma === -1) return { name: query };
  const name = query.slice(0, lastComma).trim();
  const near = query.slice(lastComma + 1).trim();
  return near.length > 0 && name.length > 0 ? { name, near } : { name: query };
}

export async function searchPlaces(query: string): Promise<PlaceSearchResult[]> {
  const apiKey = process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing EXPO_PUBLIC_FOURSQUARE_API_KEY. Copy .env.example to .env and fill in your Foursquare API key, then restart the dev server.'
    );
  }

  const { name, near } = splitNameAndLocation(query);
  const params = new URLSearchParams({ query: name, limit: '10' });
  if (near) params.set('near', near);

  const results = await runSearch(`${PLACES_SEARCH_URL}?${params.toString()}`, apiKey);
  if (results.length > 0 || near) {
    return results.map(toPlaceSearchResult);
  }

  // No explicit location given and the plain (IP-biased) query came up empty — retry with `near`
  // so Foursquare geocodes the query itself as a locality (handles typing a bare city/place name,
  // e.g. "Paris", that isn't a venue name at all).
  try {
    const nearResults = await runSearch(
      `${PLACES_SEARCH_URL}?near=${encodeURIComponent(name)}&limit=10`,
      apiKey
    );
    return nearResults.map(toPlaceSearchResult);
  } catch {
    return [];
  }
}
