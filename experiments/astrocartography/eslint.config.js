const { defineConfig, globalIgnores } = require('eslint/config');
const sharedConfig = require('@ley/config');

module.exports = defineConfig([globalIgnores(['src/webview/globeHtml.ts']), sharedConfig]);
