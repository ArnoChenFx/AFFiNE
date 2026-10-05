#!/usr/bin/env bash
# Route-B build preparation + verification.
#
#   tools/apply-patches.sh [patch-dir]        # default: patches
#
# Steps
#   1. inject the version-tolerant route-B override (tools/inject-override.mjs)
#   2. apply any extra *.patch from <patch-dir> (best effort; a patch whose
#      target is already covered by the injector is only a warning)
#   3. assert the markers really exist in the tree
#   4. execute the injected code and assert its runtime behaviour
#
# Exit: 0 ok / 1 refused (wrong architecture, missing anchor, bad behaviour)
set -euo pipefail

dir="${1:-patches}"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

fatal() { echo "apply-patches: $1" >&2; exit 1; }

echo "== route B: resolve override mode (hook | license) =="
set +e
override_out="$(OVERRIDE_MODE="${OVERRIDE_MODE:-auto}" node tools/inject-override.mjs 2>&1)"
override_rc=$?
set -e
printf '%s\n' "$override_out"
[ "$override_rc" -eq 0 ] || fatal "injector refused (see the diagnosis above)"

mode="$(printf '%s\n' "$override_out" | sed -n 's/^override-mode=//p' | tail -1)"
[ -n "$mode" ] || fatal "injector did not report a mode"
# two keys on purpose: `mode` is what fork-image.yml reads as steps.override.outputs.mode
echo "mode=$mode" >>"${GITHUB_OUTPUT:-/dev/null}"
echo "override-mode=$mode" >>"${GITHUB_OUTPUT:-/dev/null}"
echo "== override mode: $mode =="

echo "== extra patches: $dir =="
shopt -s nullglob
patches=("$dir"/*.patch)
patched_any=0
failed_any=0
if [ ${#patches[@]} -eq 0 ]; then
  echo "  none"
fi
for p in "${patches[@]}"; do
  name="$(basename "$p")"
  if git apply --check -p1 "$p" 2>/dev/null; then
    git apply -p1 "$p"; echo "  applied          $name"; patched_any=$((patched_any + 1))
  elif patch -p1 --forward --fuzz=0 --dry-run <"$p" >/dev/null 2>&1 &&
    patch -p1 --forward --fuzz=0 <"$p" >/dev/null 2>&1; then
    echo "  applied (patch)  $name"; patched_any=$((patched_any + 1))
  else
    echo "  SKIPPED          $name (does not apply to this revision)"
    failed_any=$((failed_any + 1))
  fi
done

# half-applied hunks leave .rej files / conflict markers: never accept that
if grep -rn --include='*.ts' --include='*.tsx' -e '^<<<<<<< ' -e '^>>>>>>> ' \
  packages/backend/server/src >/dev/null 2>&1 ||
  find packages/backend/server/src -name '*.rej' -print -quit 2>/dev/null | grep -q .; then
  fatal "conflict markers or .rej files found under packages/backend/server/src"
fi

if [ "$failed_any" -gt 0 ] && [ "${STRICT_PATCHES:-0}" = "1" ]; then
  fatal "$failed_any patch(es) in $dir did not apply (STRICT_PATCHES=1)"
fi

if [ "$mode" != "hook" ]; then
  echo "== hook checks skipped (license mode) =="
  echo "  this revision resolves plan/quota in the native runtime, so the TypeScript hook"
  echo "  would be dead code. Ship it with your own key pair baked in and install a license"
  echo "  you issued yourself:  node tools/issue-license.mjs --help"
  echo "apply-patches: OK (license mode, $patched_any extra patch(es) applied)"
  exit 0
fi

echo "== markers =="
marker() { # $1 = needle, rest = candidate files
  local needle="$1"
  shift
  local f
  for f in "$@"; do
    [ -f "$f" ] || continue
    if grep -q -- "$needle" "$f"; then
      echo "  ok               $f"
      return 0
    fi
  done
  echo "  MISSING          '$needle' (looked in: $*)" >&2
  return 1
}

marker SELFHOST_ENTITLEMENT_OVERRIDE \
  packages/backend/server/src/native.ts \
  packages/backend/server/src/selfhost-override.ts ||
  fatal "the override is not in the tree"
marker selfhost_team \
  packages/backend/server/src/native.ts \
  packages/backend/server/src/selfhost-override.ts ||
  fatal "the override is not in the tree"
if grep -qs 'forkIsSelfhosted' packages/backend/server/src/native.ts; then
  echo "  ok               native.ts :: forkIsSelfhosted"
fi

echo "== behaviour check (executes the injected code) =="
if [ -f tools/patched-resolver-check.ts ]; then
  if node --experimental-strip-types -e '' 2>/dev/null; then
    node --experimental-strip-types tools/patched-resolver-check.ts
  else
    echo "  skipped          $(node -v) has no --experimental-strip-types"
  fi
else
  echo "  skipped          tools/patched-resolver-check.ts not present"
fi

echo "apply-patches: OK (route B injected, $patched_any extra patch(es) applied)"
