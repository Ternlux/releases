// Builds dist-min/ — minified, comment-stripped copies of the main-process
// source (public/) and bundled plugins that ship inside the packaged app.
// The `files` mapping in package.json pulls public/ and plugins/ from here
// instead of the repo, so no readable source ends up in the asar.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-min');

// Everything under public/ that the packaged app needs at runtime.
// index.html is excluded on purpose: it's the CRA dev shell, the packaged
// renderer uses build/index.html.
const PUBLIC_ENTRIES = [
  'electron.js',
  'preload.js',
  'pluginManager.js',
  'aiProviders.js',
  'analytics.js',
  'SqliteConnectionPool.js',
  'ChatPrompts',
  'chat',
  'database',
  'docs',
  'duckdb',
  'image',
  'imports',
  'joins',
  'lib',
  'NodeExecution',
  'transfomers',
  'triggers',
  'workflows'
];

const SKIP = /\.(map|log)$|^\.DS_Store$|^\._/;

let minified = 0;
let copied = 0;

function processFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (src.endsWith('.js')) {
    const code = fs.readFileSync(src, 'utf8');
    try {
      const result = esbuild.transformSync(code, {
        loader: 'js',
        minify: true,
        legalComments: 'none', // strip every comment, including /*! */ banners
        target: 'node20' // Electron 40 ships Node 22; 20 is a safe floor
      });
      fs.writeFileSync(dest, result.code);
      minified++;
      return;
    } catch (err) {
      console.warn(`[minify-dist] could not minify ${path.relative(ROOT, src)}: ${err.message.split('\n')[0]}`);
    }
  }
  fs.copyFileSync(src, dest);
  copied++;
}

function walk(srcDir, destDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP.test(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      // Vendored third-party deps ship untouched: minifying them protects
      // nothing of ours and can break packages that ship non-JS as .js.
      // Source maps are stripped though — they map minified vendor code back
      // to readable source and are never loaded at runtime, only bloat.
      if (entry.name === 'node_modules') {
        fs.cpSync(src, dest, {
          recursive: true,
          filter: (s) => !/\.map$/.test(s),
        });
        copied++;
      } else {
        walk(src, dest);
      }
    } else if (entry.isFile()) {
      processFile(src, dest);
    }
  }
}

fs.rmSync(OUT, { recursive: true, force: true });

for (const entry of PUBLIC_ENTRIES) {
  const src = path.join(ROOT, 'public', entry);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(OUT, 'public', entry);
  if (fs.statSync(src).isDirectory()) walk(src, dest);
  else processFile(src, dest);
}

walk(path.join(ROOT, 'plugins'), path.join(OUT, 'plugins'));

console.log(`[minify-dist] ${minified} js files minified, ${copied} other files copied -> dist-min/`);
