// Windows code signing via SSL.com eSigner (cloud EV certificate).
//
// The EV private key lives in SSL.com's HSM, not on this machine, so there is
// no .pfx for electron-builder's signtool path to use. Instead electron-builder
// calls this hook once per file it wants signed (main exe, uninstaller, NSIS
// installer) and we hand each file to SSL.com's CodeSignTool, which uploads the
// hash, signs it in the cloud, timestamps it, and returns the signed binary.
//
// Requires:
//   - Java 11+ on PATH (CodeSignTool is a JAR; the macOS/Linux zip does not
//     bundle a JRE, only the Windows one does).
//   - CodeSignTool unzipped somewhere, pointed at by CODESIGNTOOL_PATH.
//   - ESIGNER_USERNAME / ESIGNER_PASSWORD / ESIGNER_CREDENTIAL_ID /
//     ESIGNER_TOTP_SECRET in the environment (loaded from .env by the
//     dist:win / pack:win / release:win scripts).
//
// Set SKIP_WIN_SIGN=true for a deliberately unsigned local build. Without it a
// missing credential is a hard failure — shipping an unsigned installer by
// accident is worse than a failed build.
//
// Also runnable directly for one-off CodeSignTool commands, with credentials
// and the truststore below wired up for you:
//
//   node scripts/esigner-sign.js get_credential_ids

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_DIR = process.env.CODESIGNTOOL_PATH
  || path.join(os.homedir(), 'CodeSignTool-v1.3.3');

// Each call is a network round trip to SSL.com plus an HSM operation; eSigner
// occasionally returns a transient error under load.
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 15000;

// ---------------------------------------------------------------------------
// Truststore
//
// CodeSignTool talks to login.ssl.com (OAuth) and cs.ssl.com (the CSC signing
// API), served by "SSL.com Root Certification Authority RSA" and the newer
// "SSL.com TLS RSA Root CA 2022" respectively. A JDK only trusts what shipped
// in its cacerts, and the 2022 root postdates most installed JDKs — so OAuth
// succeeds, then the first real API call dies with
//
//   PKIX path building failed: unable to find valid certification path
//
// which reads like a network or proxy problem and is neither. Rather than
// mutate the JDK's shared cacerts (a global trust change, easy to forget and
// invisible to the next person), the build assembles a throwaway truststore
// holding only these two roots and points the tool's JVM at it. That is also
// strictly tighter than cacerts: this JVM trusts SSL.com and nothing else.
//
// The PEMs in scripts/certs are the files published at ssl.com/repository,
// verified against the SHA-1 fingerprints listed there:
//   root RSA      B7:AB:33:08:D1:EA:44:77:BA:14:80:12:5A:6F:BD:A9:36:49:0C:BB
//   TLS root 2022 EC:2C:83:40:72:AF:26:95:10:FF:0E:F2:03:EE:31:70:F6:78:9D:CA
// ---------------------------------------------------------------------------

const ROOTS = [
  { alias: 'sslcom-root-rsa', file: 'ssl-com-root-rsa.pem' },
  { alias: 'sslcom-tls-root-2022-rsa', file: 'ssl-com-tls-root-2022-rsa.pem' },
];

const TRUSTSTORE_PASSWORD = 'changeit'; // keytool requires one; holds public roots only

let truststorePath = null;

function buildTruststore() {
  if (truststorePath) return truststorePath;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esigner-truststore-'));
  const store = path.join(dir, 'ssl-com.p12');

  for (const { alias, file } of ROOTS) {
    const pem = path.join(__dirname, 'certs', file);
    if (!fs.existsSync(pem)) {
      throw new Error(`[esigner] missing root certificate ${pem}`);
    }
    execFileSync('keytool', [
      '-importcert', '-noprompt', '-trustcacerts',
      '-alias', alias,
      '-file', pem,
      '-keystore', store,
      '-storetype', 'PKCS12',
      '-storepass', TRUSTSTORE_PASSWORD,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
  }

  truststorePath = store;
  return store;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[esigner] ${name} is not set. Windows signing needs ESIGNER_USERNAME, `
      + 'ESIGNER_PASSWORD, ESIGNER_CREDENTIAL_ID and ESIGNER_TOTP_SECRET.\n'
      + '  Put them in .env (the win build scripts source it), or set '
      + 'SKIP_WIN_SIGN=true to build an unsigned installer.'
    );
  }
  return value;
}

/**
 * The CodeSignTool JAR, invoked directly rather than through its launcher.
 *
 * CodeSignTool.sh ends in `java -jar ... $@` — with $@ UNQUOTED. Any argument
 * holding a space is re-split by the shell, so the NSIS artifacts, whose names
 * are "Ternlux Setup <version>.exe", fail with:
 *
 *   Unmatched arguments from index 6: 'Setup', '1.0.0.__uninstaller.exe'
 *
 * Quoting on our side cannot help — the re-split happens inside their script,
 * after the shell has already handed it one correct argv. So skip the launcher
 * and exec the JVM directly: execFileSync passes argv without a shell, which
 * also removes the ENOEXEC/bash and .bat/cmd special cases the launchers
 * needed. JVM flags now go on the command line instead of JAVA_TOOL_OPTIONS,
 * so the "Picked up JAVA_TOOL_OPTIONS" noise is gone too.
 */
function jarPath() {
  const jarDir = path.join(TOOL_DIR, 'jar');
  let jar;
  try {
    jar = fs.readdirSync(jarDir).find((f) => /^code_sign_tool.*\.jar$/.test(f));
  } catch (_err) {
    jar = null;
  }
  if (!jar) {
    throw new Error(
      `[esigner] CodeSignTool JAR not found under ${jarDir}. `
      + 'Unzip CodeSignTool and set CODESIGNTOOL_PATH to the folder that '
      + 'contains its jar/ directory.'
    );
  }
  return path.join(jarDir, jar);
}

function runTool(args) {
  const store = buildTruststore();
  execFileSync('java', [
    `-Djavax.net.ssl.trustStore=${store}`,
    '-Djavax.net.ssl.trustStoreType=PKCS12',
    `-Djavax.net.ssl.trustStorePassword=${TRUSTSTORE_PASSWORD}`,
    '-jar', jarPath(),
    ...args,
  ], {
    // CodeSignTool resolves conf/code_sign_tool.properties relative to here.
    cwd: TOOL_DIR,
    stdio: 'inherit',
    env: { ...process.env, CODE_SIGN_TOOL_PATH: TOOL_DIR },
  });
}

/**
 * Strip credentials out of anything headed for a log.
 *
 * Node puts the whole failing argv into execFileSync's error message, and the
 * credentials ride on argv — so an unredacted `err.message` writes the eSigner
 * password and TOTP secret into the build log, and electron-builder then
 * repeats it in its own error output. Every message derived from a tool failure
 * must go through this.
 */
function redact(text) {
  let out = String(text);
  for (const name of ['ESIGNER_PASSWORD', 'ESIGNER_TOTP_SECRET', 'ESIGNER_USERNAME', 'ESIGNER_CREDENTIAL_ID']) {
    const value = process.env[name];
    // Substring-replacing a SHORT value destroys the message: a one-character
    // username turns every occurrence of that letter into "<ESIGNER_USERNAME>"
    // and the error becomes unreadable — which is worse than useless when the
    // error is what you need to debug a failed build. Real credentials are far
    // longer than this floor; anything under it is covered by the flag-based
    // pass below, which is precise rather than value-matched.
    if (value && value.length >= 8) out = out.split(value).join(`<${name}>`);
  }
  // The reliable pass: redact by argument name, whatever the value looks like.
  return out.replace(/(-(?:password|totp_secret|username|credential_id)=)\S+/g, '$1<redacted>');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Signature cache
//
// Every signature is a metered call: SSL.com's EV Tier 1 allows 10 a month and
// bills $10 each after that, and one NSIS build spends 4 — Ternlux.exe,
// elevate.exe, the uninstaller and the installer. Two of those four are
// byte-identical between builds (elevate.exe is a static NSIS helper and never
// changes at all; Ternlux.exe changes only when the version, icon or metadata
// does), so re-signing them buys nothing but cost.
//
// So a signed result is kept, addressed by the SHA-256 of the file's UNSIGNED
// bytes. Identical input means an identical signing request, and reusing the
// earlier answer is exactly equivalent to making the call again. The stored
// signature keeps its original RFC3161 timestamp, which remains valid — proving
// when the signing happened is what a timestamp is for.
//
// The key also covers the credential, so rotating to a different certificate
// misses the cache rather than serving a signature from the old one.
//
//   ESIGNER_CACHE_DIR   where to keep it (default ~/.cache/ternlux-esigner)
//   ESIGNER_NO_CACHE    set to "true" to bypass it entirely
// ---------------------------------------------------------------------------

const CACHE_DIR = process.env.ESIGNER_CACHE_DIR
  || path.join(os.homedir(), '.cache', 'ternlux-esigner');

function cacheEnabled() {
  return String(process.env.ESIGNER_NO_CACHE).toLowerCase() !== 'true';
}

/** Cache key for a file's current (unsigned) contents under the active cert. */
function cacheKey(file) {
  const hash = crypto.createHash('sha256');
  hash.update(String(process.env.ESIGNER_CREDENTIAL_ID || ''));
  hash.update('\0');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.signed`);
}

/**
 * Copy a cached signature over `file`, or return false.
 *
 * A zero-length entry means an earlier run died between create and write, so it
 * is treated as absent and removed rather than copied over a real binary.
 */
function cacheRestore(key, file) {
  if (!cacheEnabled()) return false;
  const stored = cachePath(key);
  let size;
  try {
    size = fs.statSync(stored).size;
  } catch (_err) {
    return false;
  }
  if (size === 0) {
    fs.rmSync(stored, { force: true });
    return false;
  }
  fs.copyFileSync(stored, file);
  return true;
}

/** Remember the signed bytes now at `file` under `key`. Never fatal. */
function cacheStore(key, file) {
  if (!cacheEnabled()) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Write-then-rename: a crash mid-copy must not leave a partial binary that
    // a later build would happily ship as a signed one.
    const partial = `${cachePath(key)}.${process.pid}.partial`;
    fs.copyFileSync(file, partial);
    fs.renameSync(partial, cachePath(key));
  } catch (err) {
    console.warn(`[esigner] could not cache signature: ${err.message}`);
  }
}

/**
 * Sign one file in place.
 *
 * CodeSignTool writes the signed copy into -output_dir_path under the same
 * basename; pointing that at the input's own directory makes it prompt about
 * overwriting (and block the build waiting on stdin), so it writes to a temp
 * dir and we copy back over the original.
 */
async function signFile(file) {
  const username = requireEnv('ESIGNER_USERNAME');
  const password = requireEnv('ESIGNER_PASSWORD');
  const credentialId = requireEnv('ESIGNER_CREDENTIAL_ID');
  const totpSecret = requireEnv('ESIGNER_TOTP_SECRET');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esigner-'));
  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        // Credentials go on argv, which is visible to other processes on this
        // machine via `ps`. CodeSignTool has no stdin/env path for them.
        runTool([
          'sign',
          `-username=${username}`,
          `-password=${password}`,
          `-credential_id=${credentialId}`,
          `-totp_secret=${totpSecret}`,
          `-input_file_path=${file}`,
          `-output_dir_path=${outDir}`,
        ]);
        break;
      } catch (err) {
        if (attempt === ATTEMPTS) {
          throw new Error(redact(`[esigner] signing failed for ${file}: ${err.message}`));
        }
        console.warn(redact(
          `[esigner] attempt ${attempt} failed for ${path.basename(file)}, `
          + `retrying in ${RETRY_DELAY_MS / 1000}s: ${err.message}`
        ));
        await sleep(RETRY_DELAY_MS);
      }
    }

    // CodeSignTool exits 0 on some auth failures and just prints the error, so
    // the presence of the output file is the real success check.
    const signed = path.join(outDir, path.basename(file));
    if (!fs.existsSync(signed)) {
      throw new Error(
        `[esigner] CodeSignTool produced no output for ${file} — check the tool `
        + 'output above (bad credentials, clock skew on the TOTP, or an '
        + 'exhausted signing quota).'
      );
    }
    fs.copyFileSync(signed, file);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

exports.sign = async function sign(configuration) {
  const file = configuration.path;
  const name = path.basename(file);

  if (String(process.env.SKIP_WIN_SIGN).toLowerCase() === 'true') {
    console.warn(`[esigner] SKIP_WIN_SIGN set — leaving ${file} unsigned`);
    return;
  }

  // Hashed before signing: the key is the unsigned input, which is what
  // determines the request. signFile() replaces the file in place.
  const key = cacheEnabled() ? cacheKey(file) : null;
  if (key && cacheRestore(key, file)) {
    console.log(`[esigner] reused cached signature for ${name} (no SSL.com call)`);
    return;
  }

  console.log(`[esigner] signing ${file}`);
  await signFile(file);
  if (key) cacheStore(key, file);
  console.log(`[esigner] signed ${name}`);
};

exports.default = exports.sign;

// ---------------------------------------------------------------------------
// `totp` — local check that ESIGNER_TOTP_SECRET is the right value.
//
// There is no CodeSignTool command that validates the secret without also
// consuming a signing operation, and a wrong secret is indistinguishable from a
// wrong password in the error it produces. So compute the code here instead:
// if it matches what the authenticator app on the phone shows for eSigner, the
// secret is correct and the clock is in sync. Both are checked at once.
//
// The encoding is not documented, so every plausible reading of the secret is
// tried; exactly one should line up with the phone.
// ---------------------------------------------------------------------------

function hotp(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24
    | digest[offset + 1] << 16
    | digest[offset + 2] << 8
    | digest[offset + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) return null;
  const out = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function base64Decode(input) {
  const clean = input.replace(/\s+/g, '');
  const buf = Buffer.from(clean, 'base64');
  // Buffer.from silently drops invalid characters, so insist it round-trips.
  return buf.toString('base64').replace(/=+$/, '') === clean.replace(/=+$/, '') ? buf : null;
}

function printTotp() {
  const secret = requireEnv('ESIGNER_TOTP_SECRET');
  const counter = Math.floor(Date.now() / 1000 / 30);
  const remaining = 30 - Math.floor((Date.now() / 1000) % 30);

  const candidates = [
    ['base32', base32Decode(secret)],
    ['base64', base64Decode(secret)],
    ['raw   ', Buffer.from(secret, 'utf8')],
  ].filter(([, key]) => key && key.length);

  console.log(`secret length: ${secret.length} chars — codes valid for ${remaining}s\n`);
  for (const [encoding, key] of candidates) {
    console.log(`  ${encoding}  ${hotp(key, counter)}`);
  }
  console.log('\nOne of these should match the eSigner entry in your authenticator app.');
  console.log('If none do, the secret is wrong (or this machine\'s clock has drifted).');
}

// Direct invocation: pass the command through, filling in credentials.
// e.g. `node scripts/esigner-sign.js get_credential_ids`
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node scripts/esigner-sign.js <codesigntool-command|totp> [args...]');
    process.exit(2);
  }
  if (args[0] === 'totp') {
    try {
      printTotp();
      process.exit(0);
    } catch (err) {
      console.error(redact(err.message));
      process.exit(1);
    }
  }
  try {
    runTool([
      args[0],
      `-username=${requireEnv('ESIGNER_USERNAME')}`,
      `-password=${requireEnv('ESIGNER_PASSWORD')}`,
      ...args.slice(1),
    ]);
  } catch (err) {
    console.error(redact(err.message));
    process.exit(1);
  }
}
