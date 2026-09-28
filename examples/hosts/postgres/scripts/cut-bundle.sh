#!/usr/bin/env bash
# Cut a signed, attributable certification bundle v3 for the Postgres host at
# --target-major 1 (RFC 0168 §E.2: a certification bundle is v3 regardless of
# major, and the v1 discovery root carries the signingKeys[] that attributes it).
#
#   SUITE_VERSION=2.42.10 ./scripts/cut-bundle.sh [outfile=bundle-v3.json.new]
#   SUITE_VERSION=2.42.10 PREFLIGHT_ONLY=1 ./scripts/cut-bundle.sh
#
# Structure mirrors examples/hosts/v2-reference/scripts/cut-bundle.sh: boot the
# host fresh, PREFLIGHT the field each scenario reads, run the suite in
# --certify mode, then refuse a bundle that is not what it claims to be.
#
# Parameters (env):
#   SUITE_VERSION   REQUIRED. The published @openwop/openwop-conformance (and the
#                   exactly-pinned @openwop/spec-artifacts peer) to measure with.
#                   Installed into $SUITE_DIR, not into this package, so the
#                   version is a parameter rather than a package.json edit.
#   SUITE_DIR       Where to install it (default: $TMPDIR/openwop-suite-$SUITE_VERSION).
#   OPENWOP_BUNDLE_SIGNING_KEY   Private half (PKCS8 PEM, mode 0600). Default
#                   ~/.openwop-keys/postgres-reference-1.host.pem — it lives ONLY
#                   there, never in the repo (see keys/README.md).
#   PORT            Default 3839 (the host's default).
#   OPENWOP_OPTED_OUT_PROFILES   Passed through to the suite; an opt-out is a
#                   CLAIM recorded in the bundle, not a hiding place. Default none.
#   REQUIRE_0218=1  Fail unless both RFC 0218 rows are executed-pass (use it on the
#                   acceptance cut, against a suite that contains RFC 0218 §C).
#
# Posture: this is a LOOPBACK cut. Every suite webhook receiver is a loopback
# listener, so the host's webhook SSRF guard is opened with
# OPENWOP_WEBHOOK_ALLOW_PRIVATE=true and that relaxation is DECLARED in
# host.relaxations[] (security-defaults.md §Relaxations) — a relaxed obligation's
# profile does not certify, and the bundle says so rather than hiding it.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SUITE_VERSION:?set SUITE_VERSION to the published suite to measure with (e.g. 2.42.10)}"
OUT="${1:-bundle-v3.json.new}"
PORT="${PORT:-3839}"
BASE="http://127.0.0.1:${PORT}"
KEY="${OPENWOP_API_KEY:-openwop-postgres-dev-key}"
KEY_ID="postgres-reference-1"
SIGNING_KEY="${OPENWOP_BUNDLE_SIGNING_KEY:-$HOME/.openwop-keys/${KEY_ID}.host.pem}"
SUITE_DIR="${SUITE_DIR:-${TMPDIR:-/tmp}/openwop-suite-${SUITE_VERSION}}"
SHA="$(git rev-parse HEAD)"
RELAXATIONS='[{"obligation":"webhooks.egress-guard","durability":"session","reason":"loopback conformance cut: OPENWOP_WEBHOOK_ALLOW_PRIVATE opens this host webhook SSRF guard (scheme and private-address refusal) for registration and delivery, because every suite webhook receiver is a loopback listener"}]'

# ---- the key: present, private, and the pair of what discovery will publish
[ -f "$SIGNING_KEY" ] || { echo "no signing key at $SIGNING_KEY — it lives only under ~/.openwop-keys/ (keys/README.md)"; exit 1; }
MODE=$(stat -f '%Lp' "$SIGNING_KEY" 2>/dev/null || stat -c '%a' "$SIGNING_KEY")
[ "$MODE" = "600" ] || { echo "REFUSED: $SIGNING_KEY is mode $MODE, want 600"; exit 1; }
node -e '
const c=require("crypto"),fs=require("fs");
const priv=c.createPrivateKey(fs.readFileSync(process.argv[1],"utf8"));
const a=c.createPublicKey(priv).export({type:"spki",format:"der"});
const b=c.createPublicKey(fs.readFileSync("keys/host.pub.pem","utf8")).export({type:"spki",format:"der"});
if(!a.equals(b)){console.error("REFUSED: the private key does not pair with keys/host.pub.pem — the bundle would not verify under the published key");process.exit(1)}
' "$SIGNING_KEY"

# ---- the suite, at the requested version
if [ ! -x "$SUITE_DIR/node_modules/.bin/openwop-conformance" ] || \
   [ "$(node -p "require('$SUITE_DIR/node_modules/@openwop/openwop-conformance/package.json').version" 2>/dev/null)" != "$SUITE_VERSION" ]; then
  mkdir -p "$SUITE_DIR"; [ -f "$SUITE_DIR/package.json" ] || echo '{"private":true}' > "$SUITE_DIR/package.json"
  # The two packages are ONE release (exact peer pin); --legacy-peer-deps because
  # the suite's peer range otherwise refuses some published pairs.
  (cd "$SUITE_DIR" && npm install --no-audit --no-fund --legacy-peer-deps \
    "@openwop/openwop-conformance@$SUITE_VERSION" "@openwop/spec-artifacts@$SUITE_VERSION" >/dev/null)
fi
CLI="$SUITE_DIR/node_modules/.bin/openwop-conformance"
FIXTURES="$SUITE_DIR/node_modules/@openwop/openwop-conformance/fixtures"
echo "suite: @openwop/openwop-conformance@$("$CLI" --version 2>/dev/null || echo "$SUITE_VERSION") at $SUITE_DIR"

# ---- a FRESH host: pglite in memory, the suite's own fixture catalog
if curl -fsS "$BASE/.well-known/openwop" >/dev/null 2>&1; then
  echo "REFUSED: something already answers $BASE — a cut must measure the host it starts, not a stale process"; exit 1
fi
HOST_LOG="$(mktemp -t pg-cut-host.XXXXXX)"
cleanup() { [ -n "${HOST_PID:-}" ] && kill "$HOST_PID" 2>/dev/null; true; }
trap cleanup EXIT
OPENWOP_PORT="$PORT" OPENWOP_API_KEY="$KEY" OPENWOP_FIXTURES_DIR="$FIXTURES" \
OPENWOP_WEBHOOK_ALLOW_PRIVATE=true \
  npx tsx scripts/start-pglite.ts >"$HOST_LOG" 2>&1 &
HOST_PID=$!
for _ in $(seq 1 60); do curl -fsS "$BASE/.well-known/openwop" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$BASE/.well-known/openwop" >/dev/null || { echo "host never answered discovery ($HOST_LOG)"; exit 1; }
echo "host: pid $HOST_PID at $BASE (log $HOST_LOG)"

# ---- preflight: the FIELD each check reads, not that a process exists
DISCO="$(curl -fsS "$BASE/.well-known/openwop")"
node -e '
const d=JSON.parse(process.argv[1]), id=process.argv[2];
const k=(d.signingKeys||[]).find(x=>x.keyId===id);
if(!k){console.error(`PREFLIGHT FAIL: discovery publishes no signingKeys[] entry for ${id} — the bundle would be unattributable`);process.exit(1)}
if(!/^[A-Za-z0-9_-]{43}$/.test(k.publicKey)||k.alg!=="ed25519"||k.use!=="certification-bundle"){console.error("PREFLIGHT FAIL: malformed signingKeys entry",JSON.stringify(k));process.exit(1)}
console.log(`  signingKeys[${id}]: ${k.publicKey}`);
// The v2 reference cut starts A2A/MCP fakes because that host advertises the
// families. This one advertises neither; if it ever does, the fakes must be
// wired here first or those rows record blocked.
const fam=["a2a","mcp"].filter(f=>f in d||(d.capabilities&&f in d.capabilities));
if(fam.length){console.error(`PREFLIGHT FAIL: discovery now advertises ${fam} — wire the suite fakes into this script`);process.exit(1)}
const auth=(d.auth)||(d.capabilities&&d.capabilities.auth)||{};
if(!(auth.profiles||[]).includes("openwop-audit-log-integrity")||!auth.auditLogIntegrity?.checkpointPublicKey){console.error("PREFLIGHT FAIL: openwop-audit-log-integrity or its checkpointPublicKey is not advertised — the RFC 0218 rows would not run");process.exit(1)}
console.log("  audit-log-integrity advertised with checkpointPublicKey");
' "$DISCO" "$KEY_ID"

# RFC 0218: audit-checkpoint-signature records `inapplicable` on a host with no
# checkpoint yet. Seed one run so the first audit entry mints the first
# checkpoint, and assert /v1/audit/verify serves it before the suite starts.
curl -fsS -o /dev/null -X POST "$BASE/v1/runs" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"workflowId":"conformance-noop"}'
CPS=0
for _ in $(seq 1 30); do
  CPS=$(curl -fsS "$BASE/v1/audit/verify?fromSeq=0&toSeq=1000000" -H "Authorization: Bearer $KEY" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).checkpoints||[]).length)}catch{console.log(0)}})')
  [ "$CPS" -gt 0 ] && break; sleep 1
done
[ "$CPS" -gt 0 ] || { echo "PREFLIGHT FAIL: /v1/audit/verify serves no checkpoint — the RFC 0218 signature row would record inapplicable"; exit 1; }
echo "  audit checkpoints served: $CPS"

if [ -n "${PREFLIGHT_ONLY:-}" ]; then echo "preflight only — every precondition answered"; exit 0; fi

# ---- cut
OPENWOP_OPTED_OUT_PROFILES="${OPENWOP_OPTED_OUT_PROFILES:-}" \
OPENWOP_HOST_RELAXATIONS="$RELAXATIONS" \
OPENWOP_WEBHOOK_ALLOW_PRIVATE=true \
"$CLI" --base-url "$BASE" --api-key "$KEY" \
  --target-major 1 --max-workers 1 \
  --certify "$OUT" --bundle-version 3 --host-build "commit:$SHA" \
  --signing-key "$SIGNING_KEY" --signing-key-id "$KEY_ID" || CUT_EXIT=$?
[ -f "$OUT" ] || { echo "the suite wrote no bundle (exit ${CUT_EXIT:-0})"; exit 1; }
echo "suite exit: ${CUT_EXIT:-0} (non-zero is expected while rows fail or block; the bundle is judged below)"

# ---- the bundle measured THIS host, and its signature attributes to the published key
node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(j.suite.targetMajor!==1){console.error(`REFUSED: suite.targetMajor is ${j.suite.targetMajor}, want 1`);process.exit(1)}
if(!(j.host.relaxations||[]).length){console.error("REFUSED: loopback cut recorded NO relaxation");process.exit(1)}
' "$OUT"
node scripts/verify-bundle.mjs "$OUT" "$BASE" ${REQUIRE_0218:+--require-0218}

# The suite's own consumer verifier, under the committed public key.
set +e
"$CLI" --verify "$OUT" --host-key keys/host.pub.pem
V=$?
set -e
echo "openwop-conformance --verify exit: $V (0 verified; 1 rejected; 2 coherent-but-not-independently-verified)"
[ "$V" -eq 3 ] && { echo "REFUSED: --verify could not read the bundle"; exit 1; }
echo "bundle: $OUT — a LOOPBACK cut with a declared relaxation; NOT a certifying artifact. Do not commit it without reading the verdict."
