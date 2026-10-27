/**
 * DuckDB extensions — shipped with the app rather than fetched on demand.
 *
 * Excel and Avro are read by DuckDB's own `excel` and `avro` extensions. Both
 * are CORE extensions, so `INSTALL excel` works — but it downloads the binary
 * from extensions.duckdb.org the first time, and a desktop app cannot make a
 * user's first spreadsheet depend on a network round trip. So the binaries are
 * fetched at BUILD time (scripts/fetch-duckdb-extensions.js) and shipped in the
 * app bundle; at runtime they are installed from that local path.
 *
 * An extension binary is specific to BOTH the DuckDB version and the platform —
 * `v1.5.5/osx_arm64/excel.duckdb_extension` — and DuckDB refuses to load a
 * mismatched one. Neither is guessed here: the running engine is asked
 * (`PRAGMA platform`, `SELECT version()`) and the answer picks the file, so a
 * DuckDB upgrade that lands without a matching re-fetch fails loudly at install
 * rather than quietly loading something wrong.
 *
 * If the bundled file is missing — a build made before the fetch script ran, or
 * a platform nobody packaged for — the network install is still tried, so the
 * feature degrades to "needs a connection once" rather than breaking.
 *
 * macOS DELIBERATELY ships none, and that fallback is the whole plan there.
 * `mac.extraResources: []` in package.json keeps them out of the .app, because
 * a notarized app cannot contain one:
 *
 *   - A DuckDB extension is a Mach-O dylib with DuckDB's metadata appended PAST
 *     the end of the Mach-O structure. codesign rejects trailing data it cannot
 *     account for ("main executable failed strict validation"), so the file
 *     cannot carry a Developer ID signature.
 *   - Stripping the trailer does let codesign sign it — and then DuckDB refuses
 *     the result outright: "The file is not a DuckDB extension. The metadata at
 *     the end of the file is..." `allow_unsigned_extensions` does not help,
 *     because it is the METADATA in those bytes that is missing, not a
 *     signature. The two requirements are mutually exclusive.
 *   - Shipping it gzipped does not hide it either: Apple's notary service
 *     unpacks archives and reported the path
 *     `…/excel.duckdb_extension.gz/excel.duckdb_extension`, rejecting the
 *     ad-hoc, linker-signed binary inside as unsigned and un-timestamped.
 *
 * Extensions installed at runtime land in userData, outside the app bundle,
 * where none of this applies. Windows and Linux still bundle theirs — neither
 * platform notarizes, and there the offline-first install is free.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/** node platform+arch → the platform string DuckDB names its builds with. */
const DUCKDB_PLATFORMS = {
  'darwin:arm64': 'osx_arm64',
  'darwin:x64': 'osx_amd64',
  'linux:x64': 'linux_amd64',
  'linux:arm64': 'linux_arm64',
  // DuckDB publishes no windows_arm64 build; Windows on ARM runs the x64 one
  // through emulation, which is what an Electron x64 build does anyway.
  'win32:x64': 'windows_amd64',
  'win32:arm64': 'windows_amd64',
};

/** Every platform the fetch script knows how to download for. */
const ALL_PLATFORMS = [...new Set(Object.values(DUCKDB_PLATFORMS))];

/** The extension each file format needs before DuckDB can read it. */
const EXTENSION_FOR_FORMAT = {
  xlsx: 'excel',
  avro: 'avro',
};

/** Where the fetch script writes, and where the runtime looks. */
const BUNDLE_DIRNAME = 'duckdb-extensions';

/** The core repository a version+platform's extension is downloaded from. */
const extensionUrl = (version, platform, name) =>
  `http://extensions.duckdb.org/${version}/${platform}/${name}.duckdb_extension.gz`;

const platformFor = (nodePlatform = process.platform, nodeArch = process.arch) =>
  DUCKDB_PLATFORMS[`${nodePlatform}:${nodeArch}`] || null;

/**
 * The directory holding the bundled binaries.
 *
 * Packaged, they sit in the app's resources folder — OUTSIDE the asar archive,
 * because DuckDB installs from a real path and cannot read one from inside it.
 * In development they come from the repo's own `resources/`.
 */
function bundleDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, BUNDLE_DIRNAME));
  // public/duckdb/ → repo root
  candidates.push(path.join(__dirname, '..', '..', 'resources', BUNDLE_DIRNAME));
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[candidates.length - 1];
}

/**
 * Where a bundled extension is decompressed to before DuckDB installs it.
 *
 * Deliberately NOT the extension directory below: DuckDB owns that layout
 * (`<version>/<platform>/…`) and dropping our own files into it invites a
 * collision. A sibling directory keeps the staged copy clearly ours.
 */
function stagingDir() {
  const dir = extensionDirectory();
  if (dir) return path.join(path.dirname(dir), `${BUNDLE_DIRNAME}-staged`);
  return path.join(os.tmpdir(), `${BUNDLE_DIRNAME}-staged`); // outside Electron
}

/**
 * The bundled binary for one extension on one platform, if it is there.
 *
 * Ships gzipped (see scripts/fetch-duckdb-extensions.js): uncompressed, the
 * file is a Mach-O dylib with DuckDB's 256-byte signature appended past the end
 * of the Mach-O structure, and macOS codesign rejects that trailing data with
 * "main executable failed strict validation" — which fails the whole mac build.
 * Compressed, it is inert data nothing tries to sign.
 *
 * So the archive is expanded on first use and the expanded path returned.
 * DuckDB needs a real file to INSTALL from either way; this only moves where
 * that file comes into existence — from build time to first use.
 */
function bundledPath(platform, name) {
  const dir = path.join(bundleDir(), platform);

  // An uncompressed binary still wins if one is present — a working tree from
  // before this change, or a platform staged by hand.
  const plain = path.join(dir, `${name}.duckdb_extension`);
  if (fs.existsSync(plain)) return plain;

  const archive = path.join(dir, `${name}.duckdb_extension.gz`);
  if (!fs.existsSync(archive)) return null;

  const staged = path.join(stagingDir(), platform, `${name}.duckdb_extension`);
  try {
    // Re-use an earlier expansion, but only if it is no older than the archive:
    // an app update ships new extensions under the same names.
    if (fs.statSync(staged).mtimeMs >= fs.statSync(archive).mtimeMs) return staged;
  } catch (_err) {
    // not staged yet
  }

  fs.mkdirSync(path.dirname(staged), { recursive: true });
  // Expand to a temporary name and rename into place. A crash or a full disk
  // mid-write would otherwise leave a truncated binary that DuckDB refuses to
  // load, and the mtime check above would happily hand it back forever.
  const partial = `${staged}.${process.pid}.partial`;
  try {
    fs.writeFileSync(partial, zlib.gunzipSync(fs.readFileSync(archive)));
    fs.renameSync(partial, staged);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  return staged;
}

/**
 * Where DuckDB keeps the extensions it has installed.
 *
 * Under userData rather than DuckDB's default `~/.duckdb`, so an install is
 * scoped to this app and a locked-down home directory cannot break it. Resolved
 * lazily — a main process that never opens a spreadsheet never loads electron
 * here, and the module stays usable from a plain node script.
 */
function extensionDirectory() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    return path.join(app.getPath('userData'), BUNDLE_DIRNAME);
  } catch (_err) {
    return null; // not in Electron — DuckDB's own default applies
  }
}

// DuckDB takes forward slashes on every platform, and a Windows path's
// backslashes would otherwise have to survive a SQL string literal intact.
const pathLiteral = (value) => `'${String(value).replace(/\\/g, '/').replace(/'/g, "''")}'`;

// name → promise of the completed LOAD. Cached so concurrent readers share one
// install rather than racing to issue it twice.
const loaded = new Map();
let directorySet = false;

/** Forget what has been loaded — for when the connection behind it is gone. */
function resetExtensions() {
  loaded.clear();
  directorySet = false;
}

/**
 * Make sure `name` is installed and loaded on the shared connection.
 *
 * @param {string} name - a core extension: 'excel' or 'avro'
 * @param {{ exec: function, query: function }} runners - passed in rather than
 *   imported, so this module and public/duckdb/index.js don't require each
 *   other in a cycle.
 */
function ensureExtension(name, { exec, query }) {
  if (!loaded.has(name)) {
    const pending = (async () => {
      if (!directorySet) {
        const dir = extensionDirectory();
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
          await exec(`SET extension_directory = ${pathLiteral(dir)}`);
        }
        directorySet = true;
      }

      const { rows } = await query('PRAGMA platform');
      const platform = rows[0] && rows[0].platform;
      const bundled = platform ? bundledPath(platform, name) : null;

      if (bundled) {
        try {
          await exec(`INSTALL ${pathLiteral(bundled)}`);
        } catch (err) {
          // DuckDB refuses to install over an extension of the same name that
          // came from somewhere else — a network install by an older build of
          // this app, or by anything else sharing the extension directory. Ours
          // is the one that matches the engine we ship, so it wins. FORCE is
          // the retry rather than the default because it re-copies the binary
          // every time, and the ordinary case is that nothing is in the way.
          await exec(`FORCE INSTALL ${pathLiteral(bundled)}`);
        }
      } else {
        // Nothing shipped for this platform. The network install is the
        // fallback, and its failure carries the whole story.
        try {
          await exec(`INSTALL ${name}`);
        } catch (err) {
          throw new Error(
            `DuckDB's "${name}" extension is needed to read this file and is not bundled for `
            + `${platform || 'this platform'}. Installing it from extensions.duckdb.org failed: ${err.message}`,
          );
        }
      }

      await exec(`LOAD ${name}`);
      return name;
    })().catch((err) => {
      loaded.delete(name); // a later call gets to try again
      throw err;
    });
    loaded.set(name, pending);
  }
  return loaded.get(name);
}

module.exports = {
  ALL_PLATFORMS,
  BUNDLE_DIRNAME,
  DUCKDB_PLATFORMS,
  EXTENSION_FOR_FORMAT,
  bundleDir,
  bundledPath,
  ensureExtension,
  extensionUrl,
  platformFor,
  resetExtensions,
};
