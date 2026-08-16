const { getDefaultConfig } = require('expo/metro-config');

// Expo SDK 52+ auto-detects the pnpm workspace root from this file's location
// and configures watchFolders/node_modules resolution accordingly — no manual
// overrides needed here.
const config = getDefaultConfig(__dirname);

module.exports = config;
