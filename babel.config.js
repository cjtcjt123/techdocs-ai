const path = require('path');

// Expo nests babel-preset-expo under its own node_modules (not hoisted to the
// project root), so the bare 'babel-preset-expo' string fails to resolve from
// this config file when the Metro worker loads it. Resolve it through expo's
// package location to reuse the copy that's already installed — no new dep.
const expoDir = path.dirname(require.resolve('expo/package.json'));
const babelPresetExpo = require.resolve('babel-preset-expo', { paths: [expoDir] });

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [babelPresetExpo],
    plugins: [require('./scripts/babel-import-meta')],
  };
};
