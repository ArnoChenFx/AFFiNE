/**
 * Fork-local self-hosted entitlement override (route B).
 *
 * Why a separate file: upstream never touches it, so `git merge upstream/...`
 * can never conflict here. The only fork-local change inside an upstream file
 * is the single appended line in `native.ts` (see 00-append-hook.patch).
 *
 * How it works: `native.ts` re-exports the Rust resolver as
 *   export const resolveEntitlementV1 = (input) => serverNativeModule.resolveEntitlementV1(input);
 * i.e. it looks the property up on the shared binding object on every call.
 * Replacing that property therefore intercepts every call site (EntitlementService,
 * LicenseService, ...) without editing any of them.
 *
 * Deployment is unchanged unless DEPLOYMENT_TYPE=selfhosted (the default for
 * self-hosted images) -- cloud instances keep upstream behaviour.
 *
 * Kill switch / tuning (runtime env, no rebuild):
 *   SELFHOST_ENTITLEMENT_OVERRIDE=false   disable and fall back to upstream
 *   SELFHOST_OVERRIDE_SEATS=1..100000     seat count (default 100000)
 *
 * If the native binding turns out to be non-writable in your build, this module
 * logs an error and leaves upstream behaviour in place -- then use
 * patches/01-server-native-entitlement-override.patch instead, which changes the
 * call site directly.
 */
import serverNativeModule from '@affine/server-native';

export const SELFHOST_ENTITLEMENT_OVERRIDE =
  process.env.SELFHOST_ENTITLEMENT_OVERRIDE !== 'false';
export const SELFHOST_OVERRIDE_SEATS = (() => {
  const seat = Number(process.env.SELFHOST_OVERRIDE_SEATS ?? 100000);
  return Number.isInteger(seat) && seat >= 1 && seat <= 100000 ? seat : 100000;
})();
export const SELFHOST_OVERRIDE_PLAN = 'selfhost_team';

type NativeResolve = (input: Record<string, unknown>) => Record<string, unknown>;

const binding = serverNativeModule as unknown as {
  resolveEntitlementV1?: NativeResolve;
};

function isSelfhosted(): boolean {
  if (typeof env !== 'undefined' && env) {
    return env.selfhosted;
  }
  const deployment =
    process.env.DEPLOYMENT_TYPE ??
    (process.env.NODE_ENV === 'development' ? 'affine' : 'selfhosted');
  return deployment === 'selfhosted';
}

export function applySelfhostEntitlementOverride(): boolean {
  if (!SELFHOST_ENTITLEMENT_OVERRIDE) {
    return false;
  }

  const descriptor = Object.getOwnPropertyDescriptor(
    binding,
    'resolveEntitlementV1'
  );
  if (descriptor && !descriptor.writable && !descriptor.set) {
    console.error(
      '[selfhost-override] binding.resolveEntitlementV1 is not writable; ' +
        'apply patches/01-server-native-entitlement-override.patch instead.'
    );
    return false;
  }

  const original = binding.resolveEntitlementV1;
  if (typeof original !== 'function') {
    console.error(
      '[selfhost-override] binding.resolveEntitlementV1 is missing; skipping.'
    );
    return false;
  }
  if ((original as unknown as { __selfhostOverridden?: boolean }).__selfhostOverridden) {
    return true; // already applied
  }

  const wrapper: NativeResolve = input => {
    if (!isSelfhosted()) {
      return original.call(binding, input);
    }

    // A genuine license payload still goes through the real verifier.
    if (input?.signedPayload) {
      const real = original.call(binding, input);
      if (real?.valid === true) {
        return real;
      }
    }

    // Take the ceiling of the catalog via the sanctioned `team` entry, then
    // relabel it as the self-hosted top plan.
    const top = original.call(binding, {
      ...input,
      deploymentType: 'cloud',
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

  (wrapper as unknown as { __selfhostOverridden?: boolean }).__selfhostOverridden =
    true;
  binding.resolveEntitlementV1 = wrapper;
  return true;
}

export const selfhostOverrideApplied = applySelfhostEntitlementOverride();
