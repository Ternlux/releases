// Stage the Linux x64 native binaries a cross-build needs, then put the host's
// back.
//
// Three dependencies ship native code, and `npm install` on a mac only ever
// lays down the mac builds. Cross-building a Linux AppImage from macOS would
// otherwise pack arm64 Mach-O binaries into it and the app would die the first
// time it required one. None of them needs compiling — every one publishes a
// Linux x64 build — so this only has to put the right files where the packager
// looks.
//
// Two resolve a per-platform SIBLING package, so the Linux build can sit
// alongside the mac one and nothing has to move:
//
//   @lancedb/lancedb       → @lancedb/lancedb-linux-x64-gnu
//   @duckdb/node-bindings  → @duckdb/node-bindings-linux-x64
//
// sqlite3 is the awkward one. It loads through `bindings()`, which resolves a
// single fixed path — build/Release/node_sqlite3.node — so the Linux binary can
// only go where the mac binary already is. Staging displaces it and
// `npm run electron-dev` stays broken until it is back, which is why this has a
// restore mode and why dist:linux runs restore even when electron-builder
// fails.
//
//   node scripts/ensure-linux-prebuilts.js stage
//   node scripts/ensure-linux-prebuilts.js restore
//
// sqlite3 builds against N-API (`prebuild-install -r napi`, napi_versions 3 and
// 6), so its published binary is ABI-stable — it loads under Electron as-is,
// with no electron-rebuild step. That is what makes a plain download enough
// here, and why dist:linux can pass -c.npmRebuild=false.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const SQLITE3_DIR = path.join('node_modules', 'sqlite3');
const ACTIVE = path.join(SQLITE3_DIR, 'build', 'Release', 'node_sqlite3.node');
// The host's own binary, parked here for the length of the build.
const BACKUP = `${ACTIVE}.host`;

const log = (msg) => console.log(`[ensure-linux-prebuilts] ${msg}`);

/** Is this an ELF binary — i.e. the Linux one, already staged? */
function isElf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    return magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); // \x7fELF
  } catch (_err) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      // GitHub redirects release assets to its object store.
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
 * Unpack the Linux sibling packages, pinned to the version of the wrapper that
 * is actually installed — a prebuilt only loads into the wrapper it ships with.
 *
 * Deliberately not `npm install --no-save`, the way ensure-mac-prebuilts.js
 * does it. That makes npm reconcile the whole tree, and it aborts with ENOTEMPTY
 * trying to shuffle @lancedb/lancedb's nested apache-arrow around. These
 * packages are a binary and a package.json with no dependencies of their own, so
 * unpacking the tarball where npm would have put it is the whole job.
 */
async function unpackSibling(name, version) {
  const dest = path.join('node_modules', name);
  if (fs.existsSync(path.join(dest, 'package.json'))) {
    log(`${name}@${version} already present`);
    return;
  }

  const meta = JSON.parse(
    (await download(`https://registry.npmjs.org/${name}/${version}`)).toString('utf8')
  );
  if (!meta.dist || !meta.dist.tarball) {
    throw new Error(`no tarball published for ${name}@${version}`);
  }

  log(`unpacking ${name}@${version}`);
  const tarball = await download(meta.dist.tarball);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-prebuilt-'));
  try {
    const archive = path.join(tmp, 'package.tgz');
    fs.writeFileSync(archive, tarball);
    fs.mkdirSync(dest, { recursive: true });
    // npm tarballs wrap everything in a package/ directory.
    execFileSync('tar', ['xzf', archive, '-C', dest, '--strip-components', '1']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function installSiblings() {
  await unpackSibling(
    '@lancedb/lancedb-linux-x64-gnu',
    require('@lancedb/lancedb/package.json').version
  );
  await unpackSibling(
    '@duckdb/node-bindings-linux-x64',
    require('@duckdb/node-bindings/package.json').version
  );
}

/** Swap the Linux sqlite3 binary into the one path `bindings()` will look at. */
async function stageSqlite3() {
  const { version } = require('sqlite3/package.json');
  // napi-v6 is the highest ABI sqlite3 publishes, and N-API is forward
  // compatible, so this one file covers every Node and Electron the app runs on.
  const asset = `sqlite3-v${version}-napi-v6-linux-x64.tar.gz`;
  const url = `https://github.com/TryGhost/node-sqlite3/releases/download/v${version}/${asset}`;

  if (!fs.existsSync(ACTIVE)) {
    throw new Error(`${ACTIVE} is missing — run npm install before building`);
  }
  if (isElf(ACTIVE)) {
    log('sqlite3 linux-x64 binary already staged');
    return;
  }

  // Copy rather than rename: if anything below throws, the host binary is still
  // sitting in place and working.
  fs.copyFileSync(ACTIVE, BACKUP);
  log(`host sqlite3 binary parked at ${BACKUP}`);

  log(`downloading ${asset}`);
  const tarball = await download(url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite3-linux-'));
  try {
    const archive = path.join(tmp, asset);
    fs.writeFileSync(archive, tarball);
    execFileSync('tar', ['xzf', archive, '-C', tmp]);
    const extracted = path.join(tmp, 'build', 'Release', 'node_sqlite3.node');
    if (!isElf(extracted)) {
      throw new Error(`${asset} did not contain a Linux build of node_sqlite3.node`);
    }
    fs.copyFileSync(extracted, ACTIVE);
    log('sqlite3 linux-x64 binary staged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function restoreSqlite3() {
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, ACTIVE);
    fs.rmSync(BACKUP, { force: true });
    log('host sqlite3 binary restored');
    return;
  }
  if (isElf(ACTIVE)) {
    // Only reachable if the backup was deleted by hand mid-build.
    console.warn(
      '[ensure-linux-prebuilts] sqlite3 is still the Linux binary and no backup was found — '
      + 'run `npm rebuild sqlite3` to get this machine working again'
    );
    return;
  }
  log('nothing to restore');
}

async function main() {
  const mode = process.argv[2] || 'stage';
  if (mode === 'restore') {
    restoreSqlite3();
    return;
  }
  if (mode !== 'stage') {
    throw new Error(`unknown mode "${mode}" — expected stage or restore`);
  }
  await installSiblings();
  await stageSqlite3();
}

main().catch((err) => {
  console.error(`[ensure-linux-prebuilts] ${err.message}`);
  process.exit(1);
});
