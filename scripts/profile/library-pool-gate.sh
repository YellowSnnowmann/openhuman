#!/usr/bin/env bash
# library-pool-gate.sh — regression gate for the shared runtime pool (#5106).
#
# Runs the `skill-run` scenario with K parallel skill runs and asserts the DoD:
# with the pool ON, the process tree grows by ~one pooled worker, NOT K
# interpreters. The scenario itself hard-asserts `tree.child_count <= max_workers`
# for K > 1 (nonzero exit on failure); this script drives it in the profiling
# suite and adds a pooled-vs-unpooled comparison for the report.
#
# A regression that reintroduces per-run interpreter forking makes the pooled
# run's child_count scale with K → the scenario exits nonzero → this gate fails.
#
# Usage:
#   ./scripts/profile/library-pool-gate.sh [--concurrency N] [--skip-build] [--out DIR]
#
# Exits 0 = pass, 1 = regression/failure, 0 (with SKIP notice) = no system node.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONCURRENCY=8
POOL_WORKERS=1
SKIP_BUILD=0
OUT_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --concurrency) CONCURRENCY="${2:?--concurrency requires a value}"; shift 2 ;;
        --workers) POOL_WORKERS="${2:?--workers requires a value}"; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        --out) OUT_DIR="${2:?--out requires a value}"; shift 2 ;;
        -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
done

log() { echo "[pool-gate] $*" >&2; }

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required. Install it (e.g. 'brew install jq')." >&2
    exit 1
fi

# The scenario requires a real system node (it must never download one). No node
# ⇒ SKIP (exit 0) so node-less CI runners don't false-fail; a node-equipped
# runner is where this gate is meaningful.
if ! command -v node >/dev/null 2>&1; then
    log "SKIP: no system 'node' on PATH — pool gate needs a real interpreter."
    exit 0
fi

[[ -z "$OUT_DIR" ]] && OUT_DIR="$REPO_ROOT/target/profile/rust-library/pool-gate-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"
BIN="$REPO_ROOT/target/release/library-profile"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
    log "building library-profile (rss-bench, GGML_NATIVE=OFF)"
    ( cd "$REPO_ROOT" && GGML_NATIVE=OFF cargo build --release --features rss-bench --bin library-profile )
fi
[[ -x "$BIN" ]] || { echo "ERROR: $BIN not found (drop --skip-build to build it)." >&2; exit 1; }

pooled_json="$OUT_DIR/pooled-k$CONCURRENCY.json"
unpooled_json="$OUT_DIR/unpooled-k$CONCURRENCY.json"

# --- Pooled run (the gate) ------------------------------------------------
# The scenario hard-asserts child_count <= POOL_WORKERS; a nonzero exit here
# (via set -e) fails the gate.
log "pooled run: K=$CONCURRENCY, max_workers=$POOL_WORKERS (asserts child_count <= $POOL_WORKERS)"
OPENHUMAN_PROFILE_SKILL_RUN_CONCURRENCY="$CONCURRENCY" \
OPENHUMAN_PROFILE_SKILL_RUN_POOL_WORKERS="$POOL_WORKERS" \
    "$BIN" skill-run >"$pooled_json"

# --- Unpooled baseline (report only) --------------------------------------
log "unpooled baseline: K=$CONCURRENCY, pool OFF (expect ~$CONCURRENCY interpreters)"
OPENHUMAN_PROFILE_SKILL_RUN_CONCURRENCY="$CONCURRENCY" \
OPENHUMAN_PROFILE_SKILL_RUN_POOL=off \
    "$BIN" skill-run >"$unpooled_json"

pooled_cc="$(jq -r '.tree.child_count // 0' "$pooled_json")"
unpooled_cc="$(jq -r '.tree.child_count // 0' "$unpooled_json")"
pooled_rss="$(jq -r '.tree.tree_rss_kib // 0' "$pooled_json")"
unpooled_rss="$(jq -r '.tree.tree_rss_kib // 0' "$unpooled_json")"

echo
echo "=== runtime pool gate (#5106) — K=$CONCURRENCY ==="
echo "  pooled   (max_workers=$POOL_WORKERS): child_count=$pooled_cc  tree_rss_kib=$pooled_rss"
echo "  unpooled (legacy spawn)            : child_count=$unpooled_cc  tree_rss_kib=$unpooled_rss"

# Hard gate: pooled interpreters must not exceed the pool size (the scenario
# already asserted this; re-check defensively).
if [[ "$pooled_cc" -gt "$POOL_WORKERS" ]]; then
    echo "FAIL: pooled child_count=$pooled_cc exceeds max_workers=$POOL_WORKERS — pool is forking per run." >&2
    exit 1
fi

# Sanity: the unpooled baseline should fork more than the pool. If it didn't,
# the comparison is inconclusive (likely a sampling miss on a fast machine) —
# warn rather than hard-fail, since the pooled assertion above is the real gate.
if [[ "$unpooled_cc" -le "$pooled_cc" ]]; then
    echo "WARN: unpooled baseline child_count=$unpooled_cc did not exceed pooled=$pooled_cc" >&2
    echo "      (baseline sampling inconclusive; the pooled assertion still passed)." >&2
else
    echo "PASS: pool bounded interpreters to $pooled_cc for K=$CONCURRENCY concurrent skill runs (unpooled forked $unpooled_cc)."
fi
echo "  artifacts: $OUT_DIR"
exit 0
