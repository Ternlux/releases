// Stage the Windows x64 native binaries a cross-build needs.
//
// `npm install` on a mac lays down only the mac builds of the per-platform
// sibling packages, so a Windows build made here shipped NO native binaries at
// all for lancedb or duckdb — afterPack's prune can only delete what npm
// installed, and the win32 siblings were never there to keep. The installer
// built fine, signed fine, and died on launch:
//
//   Error: Cannot find module '@lancedb/lancedb-win32-x64-msvc'
//   at .../app.asar/node_modules/@lancedb/lancedb/dist/native.js
//
//   node scripts/ensure-win-prebuilts.js
//
// Unlike the Linux script there is nothing to restore afterwards. These are
// SIBLING packages — the win32 build sits next to the mac one and neither
// displaces the other, so `npm run electron-dev` keeps working throughout.
// sqlite3 needs nothing here either: dist:win lets electron-builder run
// @electron/rebuild, which fetches sqlite3's own win32 prebuild (verified — the
// shipped node_sqlite3.node is a PE32+ DLL). That is why only these two are
// handled, and why dist:linux, which passes -c.npmRebuild=false, has to stage
// sqlite3 by hand and this does not.
//
// Deliberately not `npm install --no-save`: that makes npm reconcile the whole
// tree and it aborts with ENOTEMPTY shuffling @lancedb/lancedb's nested
// apache-arrow. These packages are a binary plus a package.json with no
// dependencies, so unpacking the tarball where npm would have put it is the
// whole job.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const log = (msg) => console.log(`[ensure-win-prebuilts] ${msg}`);

// wrapper package → the win32 sibling that wrapper loads on Windows.
const SIBLINGS = [
  { scope: '@lancedb', wrapper: 'lancedb', sibling: 'lancedb-win32-x64-msvc' },
  { scope: '@duckdb', wrapper: 'node-bindings', sibling: 'node-bindings-win32-x64' },
];

/** Directories to skip when looking for installed copies. */
const SKIP = new Set(['dist', 'dist-min', 'build', '.git', 'resources']);

/**
 * Every `<...>/node_modules/<scope>` directory that holds `wrapper`.
 *
 * There is more than one: the app's own node_modules, and a nested copy inside
 * any plugin that depends on the package — vector-db-executor bundles its own
 * lancedb. Missing the nested one leaves that plugin broken on Windows while
 * the app itself works, which is a nastier bug than the app simply not booting.
 */
function findWrapperDirs(root, scope, wrapper) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'node_modules') {
        const scopeDir = path.join(full, scope);
        if (fs.existsSync(path.join(scopeDir, wrapper, 'package.json'))) found.push(scopeDir);
        walk(full, depth + 1); // plugins nest their own node_modules below this one
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        resolve(download(response.headers.location));
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        response.resume();
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Unpack one sibling into `scopeDir`, pinned to the version of the wrapper
 * sitting next to it — a prebuilt only loads into the wrapper it shipped with,
 * and a plugin can be on a different version from the app.
 */
async function unpackSibling(scopeDir, sibling, version) {
  const dest = path.join(scopeDir, sibling);
  if (fs.existsSync(path.join(dest, 'package.json'))) {
    const have = require(path.resolve(dest, 'package.json')).version;
    if (have === version) {
      log(`${path.join(scopeDir, sibling)}@${version} already present`);
      return;
    }
    log(`replacing ${sibling}@${have} with @${version} in ${scopeDir}`);
    fs.rmSync(dest, { recursive: true, force: true });
  }

  const pkg = `${path.basename(scopeDir)}/${sibling}`;
  const meta = JSON.parse((await download(`https://registry.npmjs.org/${pkg}/${version}`)).toString('utf8'));
  if (!meta.dist || !meta.dist.tarball) throw new Error(`no tarball published for ${pkg}@${version}`);

  log(`unpacking ${pkg}@${version} into ${scopeDir}`);
  const tarball = await download(meta.dist.tarball);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'win-prebuilt-'));
  try {
    const archive = path.join(tmp, 'package.tgz');
    fs.writeFileSync(archive, tarball);
    fs.mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['xzf', archive, '-C', dest, '--strip-components', '1']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // A prebuilt that is not actually a Windows binary would pack cleanly and
  // fail at require() time on a user's machine — exactly the bug this exists to
  // prevent. Check it here instead.
  const binary = fs.readdirSync(dest).find((f) => f.endsWith('.node'));
  if (!binary) throw new Error(`${pkg}@${version} contained no .node binary`);
  const fd = fs.openSync(path.join(dest, binary), 'r');
  try {
    const mz = Buffer.alloc(2);
    fs.readSync(fd, mz, 0, 2, 0);
    if (mz.toString('latin1') !== 'MZ') {
      throw new Error(`${binary} in ${pkg}@${version} is not a Windows PE binary`);
    }
  } finally {
    fs.closeSync(fd);
  }
  log(`  ✓ ${binary} is a Windows PE binary`);
}

async function main() {
  for (const { scope, wrapper, sibling } of SIBLINGS) {
    const scopeDirs = findWrapperDirs('.', scope, wrapper);
    if (!scopeDirs.length) {
      log(`no ${scope}/${wrapper} installed anywhere — skipping ${sibling}`);
      continue;
    }
    for (const scopeDir of scopeDirs) {
      const { version } = require(path.resolve(scopeDir, wrapper, 'package.json'));
      await unpackSibling(scopeDir, sibling, version);
    }
  }
}

main().catch((err) => {
  console.error(`[ensure-win-prebuilts] ${err.message}`);
  process.exit(1);
});
