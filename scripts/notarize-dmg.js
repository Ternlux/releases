// Notarize and staple the macOS DMGs.
//
// electron-builder's `mac.notarize` notarizes the .app and staples the ticket
// to it — then builds the DMG around the already-stapled app. The DMG itself is
// never submitted, so it carries no ticket of its own:
//
//   $ spctl -a -t open --context context:primary-signature Ternlux-1.0.0.dmg
//   rejected (source=no usable signature)
//
// The app inside still launches fine once installed, because its own ticket is
// stapled. The gap is the moment a user opens the DOWNLOADED disk image, before
// anything is installed — that is assessed against the DMG, not its contents.
//
// So this runs after every artifact is built and closes the gap: sign the DMG,
// submit it, staple the ticket. All three are free — Apple's notary service has
// no per-signature cost (roughly 75 submissions/day) and the signature is a
// local codesign with the Developer ID certificate. Nothing here touches
// SSL.com, whose signings are metered and billed.
//
// Needs APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID — the same
// credentials mac.notarize already uses, loaded from .env by the dist:mac,
// pack:mac and release:mac scripts.
//
// Set SKIP_DMG_NOTARIZE=true to skip it for a local build.

const { execFileSync } = require('child_process');
const path = require('path');

/** The signing identity, kept in step with build.mac.identity. */
const IDENTITY_NAME = require('../package.json').build.mac.identity;

function run(command, args, label) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`[notarize-dmg] ${label} failed: ${detail || err.message}`);
  }
}

async function notarizeOne(dmg, credentials) {
  const name = path.basename(dmg);

  // Apple will not issue a ticket for an unsigned disk image. This is a local
  // codesign with the Developer ID cert, not a metered operation.
  console.log(`[notarize-dmg] signing ${name}`);
  run('codesign', [
    '--sign', `Developer ID Application: ${IDENTITY_NAME}`,
    '--timestamp', '--force', dmg,
  ], `codesign ${name}`);

  console.log(`[notarize-dmg] submitting ${name} to Apple — this takes a few minutes`);
  const output = run('xcrun', [
    'notarytool', 'submit', dmg,
    '--apple-id', credentials.appleId,
    '--password', credentials.password,
    '--team-id', credentials.teamId,
    '--wait',
  ], `notarytool submit ${name}`);

  // notarytool exits 0 even when the verdict is Invalid, so the status line is
  // the real check — a rejected submission must fail the build rather than
  // quietly ship an unnotarized disk image. With --wait the output also carries
  // progress lines ("Current status: In Progress..."), so the verdict is the
  // LAST status line, not the first.
  const status = [...output.matchAll(/status:\s*(\w+)/gi)].pop()?.[1];
  if (status !== 'Accepted') {
    const id = (output.match(/id:\s*([0-9a-f-]{36})/i) || [])[1];
    throw new Error(
      `[notarize-dmg] ${name} was not accepted (status: ${status || 'unknown'}).\n`
      + (id ? `  Details: xcrun notarytool log ${id} --apple-id … --team-id …\n` : '')
      + output.trim()
    );
  }

  run('xcrun', ['stapler', 'staple', dmg], `stapler staple ${name}`);
  run('xcrun', ['stapler', 'validate', dmg], `stapler validate ${name}`);
  console.log(`[notarize-dmg] ${name}: accepted, stapled and validated`);
}

exports.default = async function afterAllArtifactBuild(buildResult) {
  const dmgs = buildResult.artifactPaths.filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return []; // not a mac build

  if (String(process.env.SKIP_DMG_NOTARIZE).toLowerCase() === 'true') {
    console.warn(`[notarize-dmg] SKIP_DMG_NOTARIZE set — leaving ${dmgs.length} DMG(s) unnotarized`);
    return [];
  }

  const credentials = {
    appleId: process.env.APPLE_ID,
    password: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  };
  const missing = Object.entries(credentials).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `[notarize-dmg] missing ${missing.join(', ')} — needs APPLE_ID, `
      + 'APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (the mac build scripts '
      + 'source .env). Set SKIP_DMG_NOTARIZE=true to build without it.'
    );
  }

  // Sequentially: two concurrent uploads of ~200MB each compete for the same
  // link, and a stalled notarytool upload is exactly how an earlier build died
  // ("abortedUpload … completedParts: []").
  for (const dmg of dmgs) {
    await notarizeOne(dmg, credentials);
  }

  return []; // the DMGs are modified in place, not replaced
};
