// Babel plugin: neutralize `import.meta` for the Expo web classic-script bundle.
//
// zustand 4.4.x ships an ESM build that uses `(import.meta.env ? import.meta.env.MODE : void 0)`.
// Metro on web bundles deps as classic <script> (not ES modules), so `import.meta`
// throws "Cannot use 'import.meta' outside a module" and the whole app white-screens.
//
// This rewrites the ENTIRE import.meta.* member chain to `undefined`, so the
// dev-only warnings evaluate falsy (skipped) with zero runtime error.
// Native (iOS/Android) is unaffected: Hermes never ships this ESM path.
module.exports = function neutralizeImportMeta() {
  function rootIsImportMeta(node) {
    if (node.type === 'MetaProperty') return true;
    if (node.type === 'MemberExpression') return rootIsImportMeta(node.object);
    return false;
  }
  return {
    name: 'neutralize-import-meta',
    visitor: {
      MemberExpression(path) {
        if (!rootIsImportMeta(path.node.object)) return;
        // Let the OUTERMOST member of the chain do the replacement, otherwise we'd
        // leave a dangling `undefined.X` (e.g. import.meta.env.MODE -> undefined.MODE).
        const parent = path.parentPath;
        if (parent.isMemberExpression() && parent.node.object === path.node) return;
        path.replaceWithSourceString('undefined');
      },
      MetaProperty(path) {
        // Truly bare `import.meta` used as a value (e.g. import.meta.url): safe object.
        if (path.parentPath.isMemberExpression()) return; // member form handled above
        path.replaceWithSourceString('({})');
      },
    },
  };
};
