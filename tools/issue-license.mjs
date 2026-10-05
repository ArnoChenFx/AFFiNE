#!/usr/bin/env node
/**
 * Offline license issuance for canary / >=0.28 self-hosted instances.
 *
 * Those revisions verify licenses against the public key baked into the native
 * binding (`AFFINE_PRO_PUBLIC_KEY`) and ship an official issuer that takes the
 * matching private key from the caller (`issueLicenseV1`). So the workflow is:
 *
 *   1. build the server with YOUR public key embedded
 *   2. issue a license with YOUR private key   <- this script
 *   3. install it (admin UI or installLicense mutation)
 *
 * Usage:
 *   node tools/issue-license.mjs --workspace <WS_ID> [--seats 100000] \
 *        --private-key pro.private.pem [--binding <dir|file>] [--out FILE] \
 *        [--id lic_lab] [--end 2126-01-01T00:00:00Z] [--public-key pro.public.pem]
 *
 * --binding accepts the built native package (a directory containing
 * index.js/*.node), a *.node file, or is auto-detected from
 * @affine/server-native / ./packages/backend/native.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const opts = args();
if (opts.help || !opts.workspace) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(2, 22).join('\n'));
  process.exit(opts.help ? 0 : 1);
}

function loadBinding(explicit) {
  const candidates = [];
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(explicit);
    candidates.push(p.endsWith('.node') ? p : join(p, 'index.js'), p);
  }
  candidates.push(
    './packages/backend/native/index.js',
    './packages/backend/native/server-native.node',
    './node_modules/@affine/server-native/index.js',
    './packages/backend/server/node_modules/@affine/server-native/index.js'
  );
  for (const c of candidates) {
    try {
      const full = isAbsolute(c) ? c : resolve(c);
      if (existsSync(full)) {
        const mod = require(full);
        if (mod && (mod.issueLicenseV1 || mod.resolveEntitlementV1)) return { binding: mod, from: full };
      }
    } catch {
      /* try the next candidate */
    }
  }
  try {
    const mod = require('@affine/server-native');
    if (mod && (mod.issueLicenseV1 || mod.resolveEntitlementV1)) {
      return { binding: mod, from: '@affine/server-native' };
    }
  } catch {
    /* ignore */
  }
  return null;
}

const found = loadBinding(opts.binding === true ? undefined : opts.binding);
if (!found) {
  console.error('[issue] could not load the native binding.');
  console.error('        pass --binding <dir|file>, or run from the repository root / server package.');
  process.exit(2);
}
const { binding, from } = found;

if (typeof binding.issueLicenseV1 !== 'function') {
  console.error(`[issue] ${from} has no issueLicenseV1().`);
  console.error('        That is the 0.27.x binding: licenses there are AES+ECDSA envelopes,');
  console.error('        generate them with affine-bypass/tools/affine-license.mjs instead.');
  process.exit(3);
}

const workspaceId = opts.workspace;
const seats = Number(opts.seats ?? 100000);
const licenseId = opts.id ?? `lic_${Date.now().toString(36)}`;
const now = new Date();
const subscriptionEnd =
  opts.end ?? new Date(now.getTime() + Number(opts.days ?? 36500) * 86400_000).toISOString();

if (typeof binding.validateLicenseSeatQuantityV1 === 'function') {
  try {
    binding.validateLicenseSeatQuantityV1(seats);
  } catch (e) {
    console.error(`[issue] seat quantity rejected by the binding: ${e.message}`);
    process.exit(4);
  }
}

const privateKeyFile = opts['private-key'];
if (!privateKeyFile) {
  console.error('[issue] --private-key <PEM file> is required (must match the embedded public key).');
  process.exit(1);
}
const privateKey = readFileSync(privateKeyFile, 'utf8');

console.log(`[issue] binding: ${from}`);
console.log(`[issue] workspace=${workspaceId} seats=${seats} id=${licenseId} end=${subscriptionEnd}`);

let license;
try {
  license = binding.issueLicenseV1({
    licenseId,
    workspaceId,
    seatQuantity: seats,
    subscriptionEnd,
    privateKey,
    now: now.toISOString(),
  });
} catch (e) {
  console.error(`[issue] issuance failed: ${e.message}`);
  process.exit(5);
}

const buf = Buffer.isBuffer(license) ? license : Buffer.from(license);
const out = opts.out ?? `workspace-${workspaceId}.license`;
writeFileSync(out, buf);
console.log(`[issue] wrote ${out} (${buf.length} bytes)`);

// self-check: verify the freshly issued license with the embedded/public key
const publicKeyFile = opts['public-key'];
if (publicKeyFile) {
  try {
    const publicKey = readFileSync(publicKeyFile, 'utf8');
    const resolved = binding.resolveEntitlementV1({
      deploymentType: 'selfhosted',
      targetType: 'workspace',
      targetId: workspaceId,
      signedPayload: buf,
      publicKey,
      now: now.toISOString(),
    });
    console.log(`[issue] self-check: valid=${resolved.valid} plan=${resolved.plan} seats=${resolved.quantity}`);
    if (!resolved.valid) {
      console.error(`[issue] the freshly issued license did NOT verify: ${resolved.errorCode ?? ''} ${resolved.errorMessage ?? ''}`);
      process.exit(6);
    }
  } catch (e) {
    console.error(`[issue] self-check failed: ${e.message}`);
    process.exit(6);
  }
} else {
  console.log('[issue] tip: pass --public-key <PEM> to self-verify before installing');
}

console.log(`
[issue] install it on the instance:
  - admin UI: Workspace -> Settings -> License -> upload ${out}
  - or GraphQL: mutation { installLicense(workspaceId: "${workspaceId}", license: <file>) { quantity recurring variant } }
  - expected result: plan "selfhost_team" (Team), seatLimit ${seats}`);
