// Faithful JS port of packages/backend/native/src/entitlement.rs (v0.27.4).
// Used by the toolkit to preview exactly what the real napi resolver returns.
// Every number below is transcribed from the Rust `plan_catalog()` fn.

export const ONE_MB = 1024 * 1024;
export const ONE_GB = 1024 * ONE_MB;
export const ONE_DAY_SECONDS = 24 * 60 * 60;
export const MAX_SEAT_QUANTITY = 100_000;

/** @returns {{name:string,blob_limit:number,storage_quota:number,history_period:number,member_limit:number|null,seat_quota:number|null,copilot_action_limit:number|null,unlimited_copilot:boolean}} */
export function planCatalog(plan, quantity) {
  const seats = quantity ?? 1;
  switch (plan) {
    case 'pro':
      return {
        name: 'pro',
        blob_limit: 100 * ONE_MB,
        storage_quota: 100 * ONE_GB,
        history_period: 30 * ONE_DAY_SECONDS,
        member_limit: 10,
        seat_quota: null,
        copilot_action_limit: 10,
        unlimited_copilot: false,
      };
    case 'lifetime_pro':
      return {
        name: 'lifetime_pro',
        blob_limit: 100 * ONE_MB,
        storage_quota: 1024 * ONE_GB,
        history_period: 30 * ONE_DAY_SECONDS,
        member_limit: 10,
        seat_quota: null,
        copilot_action_limit: 10,
        unlimited_copilot: false,
      };
    case 'ai':
      return {
        name: 'ai',
        blob_limit: 10 * ONE_MB,
        storage_quota: 10 * ONE_GB,
        history_period: 7 * ONE_DAY_SECONDS,
        member_limit: 3,
        seat_quota: null,
        copilot_action_limit: null,
        unlimited_copilot: true,
      };
    case 'team':
    case 'selfhost_team': {
      const seat_quota = 20 * ONE_GB;
      const storage_quota = seats * seat_quota + 100 * ONE_GB;
      return {
        name: plan === 'team' ? 'team' : 'selfhost_team',
        blob_limit: 500 * ONE_MB,
        storage_quota,
        history_period: 30 * ONE_DAY_SECONDS,
        member_limit: seats,
        seat_quota,
        copilot_action_limit: null,
        unlimited_copilot: false,
      };
    }
    case 'selfhost_free':
      return {
        name: 'selfhost_free',
        blob_limit: 100 * ONE_MB,
        storage_quota: 100 * ONE_GB,
        history_period: 30 * ONE_DAY_SECONDS,
        member_limit: 10,
        seat_quota: null,
        copilot_action_limit: 10,
        unlimited_copilot: false,
      };
    default:
      return {
        name: 'free',
        blob_limit: 10 * ONE_MB,
        storage_quota: 10 * ONE_GB,
        history_period: 7 * ONE_DAY_SECONDS,
        member_limit: 3,
        seat_quota: null,
        copilot_action_limit: 10,
        unlimited_copilot: false,
      };
  }
}

export class NativeInvalidArg extends Error {
  constructor(message) {
    super(message);
    this.name = 'NativeInvalidArg'; // napi Status::InvalidArg
  }
}

function quantityForPlan(plan, quantity) {
  return plan === 'team' || plan === 'selfhost_team' ? quantity : null;
}

export function quotaOf(c) {
  return {
    blobLimit: c.blob_limit,
    storageQuota: c.storage_quota,
    seatLimit: c.member_limit,
    seatQuota: c.seat_quota,
    historyPeriod: c.history_period,
    copilotActionLimit: c.copilot_action_limit,
  };
}

export function active(plan, quantity, expiresAt = null) {
  const qty = quantityForPlan(plan, quantity);
  const c = planCatalog(plan, qty);
  return {
    plan: c.name,
    valid: true,
    status: 'active',
    quantity: qty,
    expiresAt,
    subjectId: null,
    targetId: null,
    recurring: null,
    issuedAt: null,
    entity: null,
    issuer: null,
    quota: quotaOf(c),
    flags: { unlimitedCopilot: c.unlimited_copilot },
    errorCode: null,
    errorMessage: null,
  };
}

export function expired(plan, quantity, expiresAt, errorCode) {
  return {
    ...active(plan, quantity, expiresAt),
    plan: 'selfhost_team',
    valid: false,
    status: 'expired',
    errorCode,
    errorMessage: 'license expired',
  };
}

export function invalidLicense(errorCode, errorMessage) {
  const c = planCatalog('selfhost_free', null);
  return {
    plan: c.name,
    valid: false,
    status: 'needs_reupload',
    quantity: null,
    expiresAt: null,
    subjectId: null,
    targetId: null,
    recurring: null,
    issuedAt: null,
    entity: null,
    issuer: null,
    quota: quotaOf(c),
    flags: { unlimitedCopilot: c.unlimited_copilot },
    errorCode,
    errorMessage,
  };
}

/**
 * Mirrors resolve_entitlement_v1() minus the AES/ECDSA branch (that lives in
 * affine-license.mjs, which re-implements decrypt_license/verify_license).
 */
export function resolveEntitlementV1(input) {
  if (!['cloud', 'selfhosted'].includes(input.deploymentType)) {
    throw new NativeInvalidArg('deploymentType must be cloud or selfhosted');
  }
  if (!['user', 'workspace', 'instance'].includes(input.targetType)) {
    throw new NativeInvalidArg('targetType must be user, workspace, or instance');
  }
  if (input.quantity != null && !(input.quantity > 0 && input.quantity <= MAX_SEAT_QUANTITY)) {
    throw new NativeInvalidArg('quantity must be between 1 and 100000');
  }
  if (input.signedPayload) {
    throw new Error('signedPayload branch is implemented in affine-license.mjs');
  }

  const plan =
    input.plan ?? (input.deploymentType === 'selfhosted' ? 'selfhost_free' : 'free');

  // THE LICENSE GATE (entitlement.rs:L134-L136)
  if (input.deploymentType === 'selfhosted' && plan !== 'selfhost_free') {
    throw new NativeInvalidArg('selfhosted commercial entitlements require signedPayload');
  }
  return active(plan, input.quantity ?? null);
}

/** What the patched native.ts wrapper returns (must mirror patch 01 exactly). */
export function bypassedEntitlement(targetType, seats = MAX_SEAT_QUANTITY, now = new Date()) {
  const top = resolveEntitlementV1({
    deploymentType: 'cloud', // use the sanctioned cloud catalog...
    targetType,
    plan: 'team', // ...then relabel it as the self-hosted top plan
    quantity: seats,
    now: now.toISOString(),
  });
  return {
    ...top,
    plan: 'selfhost_team',
    valid: true,
    status: 'active',
    flags: { ...top.flags, unlimitedCopilot: true },
  };
}

export function human(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}
