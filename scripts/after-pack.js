// Ad-hoc codesigns macOS builds so unsigned arm64 (and x64) apps launch
// without Gatekeeper killing the renderer (white-screen / SIGKILL).
// Also prunes wrong-platform lancedb prebuilt binaries — @lancedb ships
// every (os,arch) binary as a sibling package, and they all get installed
// into node_modules. Without this prune each build carries ~210MB of
// dead weight.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

// Both @lancedb and @duckdb ship one prebuilt per (os,arch) as a sibling
// package. A cross-build installs the target's alongside the host's, and
// without pruning every bundle carries both — the macOS libduckdb.dylib alone
// is 112MB. For each scope: which sibling this platform actually loads, plus
// the names that are never a prebuilt and must always survive.
const PREBUILT_SCOPES = [
  {
    scope: '@lancedb',
    always: ['lancedb'],                          // the JS wrapper
    keep: {
      'darwin-arm64': 'lancedb-darwin-arm64',
      'darwin-x64':   'lancedb-darwin-x64',
      'linux-arm64':  'lancedb-linux-arm64-gnu',
      'linux-x64':    'lancedb-linux-x64-gnu',
      'win32-x64':    'lancedb-win32-x64-msvc',
    },
  },
  {
    scope: '@duckdb',
    always: ['node-api', 'node-bindings'],        // JS wrapper + loader
    keep: {
      'darwin-arm64': 'node-bindings-darwin-arm64',
      'darwin-x64':   'node-bindings-darwin-x64',
      'linux-arm64':  'node-bindings-linux-arm64',
      'linux-x64':    'node-bindings-linux-x64',
      'win32-x64':    'node-bindings-win32-x64',
    },
  },
];

function getResourcesDir(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

/**
 * Every directory with this scope name under the packed app.
 *
 * There is more than one: the app's own node_modules, and a nested copy inside
 * any plugin that depends on the package (vector-db-executor bundles its own
 * lancedb). The nested ones matter most on a cross-build — a mac host only ever
 * installs the mac prebuilt, so a plugin's private copy is the one place a
 * darwin binary can still ride into a Linux bundle.
 */
function findScopeDirs(root, scope) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return; // unreadable or vanished — nothing to prune here
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === scope) {
        found.push(full); // no need to descend into a match
        continue;
      }
      walk(full);
    }
  };
  walk(root);
  return found;
}

/**
 * Drop every prebuilt that is not this platform's.
 *
 * Done here rather than with a `!` pattern in linux.files: a platform-specific
 * `files` array REPLACES the root one, and electron-builder treats a list of
 * only-negations as "include everything except these" (fileMatcher.js, via
 * containsOnlyIgnore) — which quietly packs the entire project directory,
 * source and dotfiles included. afterPack has no such trap.
 */
function prunePrebuilts(context) {
  const archStr = ARCH_NAMES[context.arch] || String(context.arch);
  const platformKey = `${context.electronPlatformName}-${archStr}`;

  const unpacked = path.join(getResourcesDir(context), 'app.asar.unpacked');
  if (!fs.existsSync(unpacked)) return;

  for (const { scope, always, keep } of PREBUILT_SCOPES) {
    const active = keep[platformKey];
    if (!active) {
      console.warn(`[after-pack] no ${scope} prebuilt mapped for ${platformKey} — skipping prune`);
      continue;
    }
    for (const scopeDir of findScopeDirs(unpacked, scope)) {
      for (const entry of fs.readdirSync(scopeDir)) {
        if (always.includes(entry)) continue;     // wrapper/loader — always keep
        if (entry === active) continue;           // this platform's prebuilt
        const full = path.join(scopeDir, entry);
        console.log(`[after-pack] pruning ${full}`);
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shipping guard
//
// The `files` config in package.json is the only thing keeping the repo out of
// the shipped artifact, and it can fail SILENTLY. It did: a `linux.files` array
// holding nothing but `!` negations made electron-builder prepend `**/*`
// (fileMatcher.js, containsOnlyIgnore), packing .env — Apple and GitHub tokens
// included — along with the whole source tree into a Linux build. Nothing in
// the build output said so; it only surfaced when someone opened the asar.
//
// So the build asserts what it shipped instead of trusting the config. A new
// top-level entry, or a secret/source/map/log file in the app's own code, fails
// the build. Adding a legitimate new root means adding it here deliberately.
// ---------------------------------------------------------------------------

const ALLOWED_ASAR_ROOTS = new Set(['build', 'node_modules', 'package.json', 'plugins', 'public']);

/** Never belongs in a shipped build, outside of dependencies. */
function isForbidden(name) {
  return name === '.env' || name.startsWith('.env.')
    || name === '.git' || name === '.claude' || name === '.npmrc'
    || /\.(map|log|pem|key|p12|keystore)$/i.test(name);
}

/**
 * The asar header, without pulling in @electron/asar.
 *
 * Layout: four little-endian uint32s — pickle size, header size, object size,
 * string size — then the JSON header of that last length.
 */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizes = Buffer.alloc(16);
    fs.readSync(fd, sizes, 0, 16, 0);
    const stringSize = sizes.readUInt32LE(12);
    const header = Buffer.alloc(stringSize);
    fs.readSync(fd, header, 0, stringSize, 16);
    return JSON.parse(header.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Forbidden files in the app's OWN code. node_modules is skipped deliberately:
 * dependencies legitimately ship .map files and dotfiles by the thousand, and
 * failing on those would make the guard noise that gets switched off.
 */
function findForbidden(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = `${prefix}/${name}`;
    if (isForbidden(name)) out.push(full);
    if (entry.files) {
      if (name === 'node_modules') continue;
      findForbidden(entry, full, out);
    }
  }
  return out;
}

/**
 * Directories shipped twice — minified under public/, readable under build/.
 *
 * minify-dist.js stages public/ into dist-min/public, and the `files` mapping
 * packs that as the app's public/. But create-react-app also copies everything
 * in public/ into build/, and build/ is packed wholesale minus a hand-written
 * list of `!build/<dir>/**` negations. Miss one and the original source ships
 * alongside the minified copy, comments and all — which is exactly what
 * happened to build/duckdb (97KB of commented source) and build/image.
 *
 * Any directory present under both roots means a negation is missing.
 */
function findMinifyBypass(header) {
  const dirsOf = (root) => {
    const node = (header.files || {})[root];
    if (!node || !node.files) return [];
    return Object.entries(node.files)
      .filter(([, entry]) => entry.files != null)
      .map(([name]) => name);
  };

  const publicDirs = new Set(dirsOf('public'));
  return dirsOf('build').filter((name) => publicDirs.has(name)).sort();
}

function verifyAsarContents(context) {
  const asarPath = path.join(getResourcesDir(context), 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.log('[after-pack] no app.asar (asar disabled) — skipping shipping guard');
    return;
  }

  const header = readAsarHeader(asarPath);
  const roots = Object.keys(header.files || {});

  const unexpected = roots.filter((name) => !ALLOWED_ASAR_ROOTS.has(name)).sort();
  if (unexpected.length) {
    throw new Error(
      `[after-pack] app.asar has unexpected top-level entries: ${unexpected.join(', ')}\n`
      + `  Expected only: ${[...ALLOWED_ASAR_ROOTS].sort().join(', ')}\n`
      + '  This usually means a "files" pattern stopped restricting what gets packed —\n'
      + '  check that no platform-specific files array contains only "!" negations.\n'
      + '  If the new entry is intentional, add it to ALLOWED_ASAR_ROOTS in this file.'
    );
  }

  const forbidden = findForbidden(header, '', []).sort();
  if (forbidden.length) {
    throw new Error(
      `[after-pack] app.asar contains files that must never ship:\n${forbidden.map((f) => `    ${f}`).join('\n')}`
    );
  }

  const duplicated = findMinifyBypass(header);
  if (duplicated.length) {
    throw new Error(
      `[after-pack] app.asar ships unminified copies of main-process source:\n`
      + duplicated.map((d) => `    build/${d}/  (also present, minified, at public/${d}/)`).join('\n')
      + '\n  CRA copies all of public/ into build/, so every directory minify-dist.js\n'
      + '  stages into dist-min/public needs a matching "!build/<dir>/**" entry in the\n'
      + '  "files" array of package.json. Add the missing ones there.'
    );
  }

  console.log(`[after-pack] shipping guard OK — roots: ${roots.sort().join(', ')}`);
}

exports.default = async function afterPack(context) {
  prunePrebuilts(context);
  verifyAsarContents(context);

  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[after-pack] cleaning detritus from ${appPath}`);
  try {
    // .DS_Store and ._* AppleDouble files trip up codesign
    execFileSync('find', [appPath, '-name', '.DS_Store', '-delete'], { stdio: 'inherit' });
    execFileSync('find', [appPath, '-name', '._*', '-delete'], { stdio: 'inherit' });
    execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  } catch (err) {
    console.warn('[after-pack] cleanup failed:', err.message);
  }

  // Ad-hoc signing disabled — we now sign with a real Developer ID cert
  // (Developer ID Application: Ternlux Inc). electron-builder runs afterPack
  // BEFORE its own signing, so any ad-hoc sign here would just be overwritten
  // (or leave stray --deep signatures). Kept for reference / unsigned dev builds.
  // console.log(`[after-pack] ad-hoc signing ${appPath}`);
  // try {
  //   execFileSync(
  //     'codesign',
  //     ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
  //     { stdio: 'inherit' }
  //   );
  // } catch (err) {
  //   console.warn('[after-pack] ad-hoc codesign failed:', err.message);
  // }
};
