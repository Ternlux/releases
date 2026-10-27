#!/usr/bin/env node
/**
 * Download the DuckDB extensions the app ships with.
 *
 * Excel and Avro are read by DuckDB's `excel` and `avro` extensions. They are
 * core extensions, so `INSTALL excel` would fetch them — over the network, on
 * the user's first spreadsheet. Instead they are downloaded here at build time
 * and installed from disk at runtime (public/duckdb/extensions.js).
 *
 * A binary is specific to BOTH the DuckDB version and the platform, so the
 * version is read from the installed @duckdb/node-api rather than written down
 * anywhere: bump the dependency, re-run this, and the right files appear.
 *
 *   node scripts/fetch-duckdb-extensions.js              # this machine
 *   node scripts/fetch-duckdb-extensions.js --all        # every platform
 *   node scripts/fetch-duckdb-extensions.js osx_arm64 windows_amd64
 *
 * Output: resources/duckdb-extensions/<platform>/<name>.duckdb_extension.gz
 * Kept gzipped as served (see fetchOne); the runtime decompresses on first use.
 * Roughly 4 MB per extension per platform, so builds fetch only what they ship.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const {
  ALL_PLATFORMS, BUNDLE_DIRNAME, extensionUrl, platformFor,
} = require('../public/duckdb/extensions');

// `sqlite_scanner` is how DuckDB reads SQLite files (public/duckdb attachDb).
// Its canonical name, not the `sqlite` alias: the download URL uses it.
const EXTENSIONS = ['excel', 'avro', 'sqlite_scanner'];
const OUT_ROOT = path.join(__dirname, '..', 'resources', BUNDLE_DIRNAME);

/** The DuckDB version the installed bindings speak, as DuckDB tags it. */
function duckdbVersion() {
  // "1.5.5-r.3" — the -r suffix is the bindings' own release, not DuckDB's.
  const { version } = require('../node_modules/@duckdb/node-api/package.json');
  return `v${String(version).split('-')[0]}`;
}

// Records which DuckDB the binaries in OUT_ROOT were built for. An extension
// only loads into the version it was compiled against, so a stale folder is
// worse than an empty one.
const VERSION_MARKER = '.duckdb-version';

/** Is every requested platform already present, for this DuckDB? */
function isSatisfied(version, platforms) {
  try {
    if (fs.readFileSync(path.join(OUT_ROOT, VERSION_MARKER), 'utf8').trim() !== version) return false;
  } catch (_err) {
    return false; // no marker — treat as empty
  }
  return platforms.every((platform) => EXTENSIONS.every((name) =>
    fs.existsSync(path.join(OUT_ROOT, platform, `${name}.duckdb_extension.gz`))));
}

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (response) => {
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

async function fetchOne(version, platform, name) {
  const outDir = path.join(OUT_ROOT, platform);
  const outFile = path.join(outDir, `${name}.duckdb_extension.gz`);
  const url = extensionUrl(version, platform, name);

  // Stored STILL COMPRESSED, exactly as the repository serves it.
  //
  // An uncompressed extension is a Mach-O dylib with DuckDB's own 256-byte
  // signature appended past the end of the Mach-O structure. On macOS,
  // electron-builder signs every Mach-O it finds in the bundle, and codesign
  // rejects that trailing data:
  //
  //   avro.duckdb_extension: main executable failed strict validation
  //
  // Gzipped, the file is just data — codesign and the notary service have
  // nothing to object to, and the bundle is about half the size. The runtime
  // (public/duckdb/extensions.js) decompresses into DuckDB's extension
  // directory the first time an extension is needed.
  const gz = await download(url);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, gz);

  // A previous build may have left the uncompressed binary beside it; it would
  // still be picked up and packaged, reintroducing the signing failure.
  const legacy = path.join(outDir, `${name}.duckdb_extension`);
  if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });

  return { outFile, bytes: gz.length, rawBytes: zlib.gunzipSync(gz).length };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--all');
  const wantsAll = process.argv.includes('--all');

  let platforms;
  if (wantsAll) {
    platforms = ALL_PLATFORMS;
  } else if (args.length) {
    platforms = args;
  } else {
    const here = platformFor();
    if (!here) {
      console.error(`No DuckDB build for ${process.platform}/${process.arch}. Pass platforms explicitly.`);
      process.exit(1);
    }
    platforms = [here];
  }

  const unknown = platforms.filter((p) => !ALL_PLATFORMS.includes(p));
  if (unknown.length) {
    console.error(`Unknown platform(s): ${unknown.join(', ')}\nKnown: ${ALL_PLATFORMS.join(', ')}`);
    process.exit(1);
  }

  const version = duckdbVersion();
  const optional = process.argv.includes('--optional');
  console.log(`DuckDB ${version} → ${path.relative(process.cwd(), OUT_ROOT)}`);

  // Already have exactly what was asked for, for this DuckDB? Then there is
  // nothing to do — which is what keeps this cheap enough to run from
  // postinstall on every `npm install`.
  if (isSatisfied(version, platforms)) {
    console.log('  · already present, nothing to fetch');
    return;
  }

  // Start clean: everything left here is shipped, so a binary for a platform
  // this build no longer targets — or for a DuckDB version it no longer runs —
  // would be dead weight the app might then try to install.
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });

  let failed = 0;
  for (const platform of platforms) {
    for (const name of EXTENSIONS) {
      try {
        const { bytes } = await fetchOne(version, platform, name);
        console.log(`  ✓ ${platform}/${name} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
      } catch (error) {
        failed++;
        console.error(`  ✗ ${platform}/${name}: ${error.message}`);
      }
    }
  }

  if (failed) {
    // Visible either way, because an app built without these asks the user's
    // machine for a network connection the first time they open a spreadsheet.
    console.error(`\n${failed} extension(s) could not be fetched. Excel and Avro files will need`);
    console.error('a network connection the first time one is opened.');
    // From postinstall this must not fail the install — someone running
    // `npm ci` offline still wants their dependencies.
    process.exit(optional ? 0 : 1);
  }

  fs.writeFileSync(path.join(OUT_ROOT, VERSION_MARKER), version);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
