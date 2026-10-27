// LanceDB ships per-arch native binaries as separate npm packages
// (`@lancedb/lancedb-darwin-x64`, `-darwin-arm64`, …) listed under
// optionalDependencies. npm installs only the one matching the host arch,
// so on an arm64 host the x64 prebuilt is missing — and the resulting
// Intel DMG can't load lancedb at runtime.
//
// Before a mac build, force-install both prebuilts at the same version as
// the installed lancedb wrapper. The afterPack hook prunes the wrong-arch
// one out of each per-arch app bundle.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { version } = require('@lancedb/lancedb/package.json');

const archs = ['x64', 'arm64'];
const missing = archs.filter(arch =>
  !fs.existsSync(path.join('node_modules', '@lancedb', `lancedb-darwin-${arch}`, 'package.json'))
);

if (missing.length === 0) {
  console.log(`[ensure-mac-prebuilts] @lancedb/lancedb-darwin-{x64,arm64}@${version} already installed`);
  process.exit(0);
}

const specs = missing.map(arch => `@lancedb/lancedb-darwin-${arch}@${version}`);
console.log(`[ensure-mac-prebuilts] installing ${specs.join(' ')}`);
execFileSync(
  'npm',
  ['install', '--no-save', '--force', ...specs],
  { stdio: 'inherit' }
);
