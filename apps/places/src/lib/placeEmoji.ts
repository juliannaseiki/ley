// Mirrors emojiForPlaceId in webview-src/globe-entry.js exactly, so a saved place shows the same
// flower here as on its map pin — same emoji list, same hash, same modulo.
const FLOWER_EMOJIS = ['🌸', '🌷', '🌹', '🌺', '🌻', '🌼'];

export function emojiForPlaceId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return FLOWER_EMOJIS[hash % FLOWER_EMOJIS.length];
}
