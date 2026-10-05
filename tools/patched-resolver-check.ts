// Behaviour check for the route-B override: executes the injected block VERBATIM
// (delimited by the fork-ci:selfhost-override sentinels in
// packages/backend/server/src/native.ts) against a faithful JS port of the Rust
// `resolve_entitlement_v1` (tools/entitlement-catalog.mjs).
//
//   node --experimental-strip-types tools/patched-resolver-check.ts
//   SELFHOST_ENTITLEMENT_OVERRIDE=false node ...   # kill switch
//   SELFHOST_OVERRIDE_SEATS=25          node ...   # custom seat count
import { resolveEntitlementV1 as rustResolve } from './entitlement-catalog.mjs';

type ResolveEntitlementInput = {
  deploymentType: string;
  targetType: string;
  targetId?: string;
  plan?: string;
  quantity?: number;
  signedPayload?: unknown;
  publicKey?: string;
  licenseAesKey?: string;
  now: string;
};
type ResolvedEntitlement = Record<string, any>;

const serverNativeModule: {
  resolveEntitlementV1: (input: ResolveEntitlementInput) => ResolvedEntitlement;
} = { resolveEntitlementV1: rustResolve as any };
(globalThis as any).env = { selfhosted: true };

// ================== verbatim injected block (sentinels stripped) ==================

// Route B: keep the native verifier intact -- it is still the only place that
// turns a plan into a quota -- but take the ceiling of the catalog for every
// target instead of letting self-hosted fall back to `selfhost_free`.
//
// Runtime switches (no rebuild needed):
//   SELFHOST_ENTITLEMENT_OVERRIDE=false   -> upstream behaviour
//   SELFHOST_OVERRIDE_SEATS=1..100000     -> seat count (default 100000)
export const SELFHOST_ENTITLEMENT_OVERRIDE =
  process.env.SELFHOST_ENTITLEMENT_OVERRIDE !== 'false';
export const SELFHOST_OVERRIDE_SEATS = (() => {
  const seat = Number(process.env.SELFHOST_OVERRIDE_SEATS ?? 100000);
  return Number.isInteger(seat) && seat >= 1 && seat <= 100000 ? seat : 100000;
})();
export const SELFHOST_OVERRIDE_PLAN = 'selfhost_team';

const forkIsSelfhosted = (): boolean => {
  if (typeof env !== 'undefined' && env) return env.selfhosted;
  const deployment =
    process.env.DEPLOYMENT_TYPE ??
    (process.env.NODE_ENV === 'development' ? 'affine' : 'selfhosted');
  return deployment === 'selfhosted';
};

export const resolveEntitlementV1 = (
  ...args: Parameters<typeof serverNativeModule.resolveEntitlementV1>
): ResolvedEntitlement => {
  if (!SELFHOST_ENTITLEMENT_OVERRIDE || !forkIsSelfhosted()) {
    return serverNativeModule.resolveEntitlementV1(...args);
  }

  // a genuine license payload still goes through the real verifier
  const input = args[0] as ResolveEntitlementInput | undefined;
  if (input?.signedPayload) {
    const real = serverNativeModule.resolveEntitlementV1(...args);
    if (real?.valid === true) {
      return real;
    }
  }

  // ask the native module for the sanctioned `team` catalog (legal on the
  // "cloud" deployment type), then relabel it as the self-hosted top plan
  const top = serverNativeModule.resolveEntitlementV1({
    ...(input as ResolveEntitlementInput),
    deploymentType: 'cloud',
    targetType: input?.targetType ?? 'workspace',
    plan: 'team',
    quantity: SELFHOST_OVERRIDE_SEATS,
    signedPayload: undefined,
    publicKey: undefined,
    licenseAesKey: undefined,
  });

  return {
    ...top,
    plan: SELFHOST_OVERRIDE_PLAN,
    valid: true,
    status: 'active',
    flags: { ...(top?.flags ?? {}), unlimitedCopilot: true },
  };
};

// ================================ end verbatim ================================

const NOW = '2026-10-05T00:00:00.000Z';
const OFF = process.env.SELFHOST_ENTITLEMENT_OVERRIDE === 'false';
const SEATS = Number(process.env.SELFHOST_OVERRIDE_SEATS ?? 100000);
const seats = Number.isInteger(SEATS) && SEATS >= 1 && SEATS <= 100000 ? SEATS : 100000;

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  got=${String(actual)} want=${String(expected)}`);
};

console.log('\n1. fresh self-hosted instance, zero DB rows (= EntitlementService.builtinFree)');
const ws = resolveEntitlementV1({ deploymentType: 'selfhosted', targetType: 'workspace', now: NOW });
check('plan', ws.plan, OFF ? 'selfhost_free' : 'selfhost_team');
check('valid', ws.valid, true);
check('quota.seatLimit', ws.quota.seatLimit, OFF ? 10 : seats);
check('quota.storageQuota', ws.quota.storageQuota, OFF ? 100 * 1024 ** 3 : seats * 20 * 1024 ** 3 + 100 * 1024 ** 3);
check('quota.blobLimit', ws.quota.blobLimit, OFF ? 100 * 1024 ** 2 : 500 * 1024 ** 2);
check('copilotActionLimit', ws.quota.copilotActionLimit, OFF ? 10 : null);
check('flags.unlimitedCopilot', ws.flags.unlimitedCopilot, !OFF);

console.log('\n2. user target (self-hosted user entitlement rows are unreachable)');
const usr = resolveEntitlementV1({ deploymentType: 'selfhosted', targetType: 'user', now: NOW });
check('plan', usr.plan, OFF ? 'selfhost_free' : 'selfhost_team');
check('quota.seatLimit', usr.quota.seatLimit, OFF ? 10 : seats);

console.log('\n3. a genuine signed license payload still goes through the real verifier');
serverNativeModule.resolveEntitlementV1 = ((i: any) =>
  i.signedPayload
    ? { plan: 'pro', valid: true, status: 'active', quota: { seatLimit: 10 } }
    : rustResolve(i)) as any;
const licensed = resolveEntitlementV1({
  deploymentType: 'selfhosted', targetType: 'workspace', signedPayload: Buffer.from('x'), now: NOW,
});
check('verified payload wins', licensed.plan, 'pro');
serverNativeModule.resolveEntitlementV1 = ((i: any) =>
  i.signedPayload
    ? { plan: 'selfhost_free', valid: false, status: 'needs_reupload', quota: {} }
    : rustResolve(i)) as any;
const rejected = resolveEntitlementV1({
  deploymentType: 'selfhosted', targetType: 'workspace', signedPayload: Buffer.from('junk'), now: NOW,
});
check('rejected payload upgraded', rejected.plan, OFF ? 'selfhost_free' : 'selfhost_team');
serverNativeModule.resolveEntitlementV1 = rustResolve as any;

console.log('\n4. cloud deployment untouched');
(globalThis as any).env = { selfhosted: false };
const cloud = resolveEntitlementV1({ deploymentType: 'cloud', targetType: 'workspace', plan: 'pro', now: NOW });
check('plan passthrough', cloud.plan, 'pro');

console.log(`\n${failures === 0 ? 'ALL GREEN' : 'FAILURES: ' + failures}`);
process.exit(failures === 0 ? 0 : 1);
