#!/usr/bin/env bash
# Cut the signed certification bundle for this host.
#
# Every optional family this host advertises needs a fixture running, and RFC
# 0168 §E.1 denies certification for ANY `blocked` row — so a dead fixture and a
# broken host produce the SAME verdict from opposite causes. This script
# therefore PREFLIGHTS each fixture by driving a real exchange and checking the
# FIELD the scenario reads, and refuses to start the suite unless every one
# answers. (Measured 2026-09-17: a synthetic IdP tied to its stdin exited on a
# detached launch and blocked three rows in a cut whose other 226 passed.)
#
#   ./scripts/cut-bundle.sh [outfile=bundle-v3.json.new]
#   PREFLIGHT_ONLY=1 ./scripts/cut-bundle.sh   # check the fixtures, skip the suite
#
# Requires: keys/host.pem (npm run keygen), the suite installed, port 3838 free.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-bundle-v3.json.new}"
PORT=3838
BASE="http://127.0.0.1:${PORT}"
KEY="openwop-v2-dev-key"
IDP_PORT="${IDP_PORT:-3839}"
IDP="http://127.0.0.1:${IDP_PORT}"
SHA="$(git rev-parse HEAD)"

cleanup() { [ -n "${HOST_PID:-}" ] && kill "$HOST_PID" 2>/dev/null; [ -n "${IDP_PID:-}" ] && kill "$IDP_PID" 2>/dev/null; true; }
trap cleanup EXIT

# No `npm run build` here: this tsconfig EMITS, and a dist/ tree makes `npx vitest
# run` pick up dist/test/*.js and fail. Typecheck with `npx tsc --noEmit` instead.
# ALLOW_PRIVATE is required, not optional: the suite's webhook receivers and the
# synthetic IdP are both on loopback, and the egress guard refuses them without it.
OPENWOP_WEBHOOK_ALLOW_PRIVATE=1 OPENWOP_IMPLEMENTED_CHANGE_IDS=rfc-0176-witness npx tsx src/server.ts "$PORT" >/tmp/cut-host.log 2>&1 &
HOST_PID=$!
# `< /dev/null` would end the IdP's stdin at once; it exits with its parent ONLY
# when handed `--exit-with-parent`, so a detached launch here is safe.
nohup npx tsx scripts/synthetic-idp.ts "$IDP_PORT" >/tmp/cut-idp.log 2>&1 < /dev/null &
IDP_PID=$!

for _ in $(seq 1 60); do
  curl -fsS "$BASE/.well-known/openwop" -H 'OpenWOP-Version: 2.0' >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$BASE/.well-known/openwop" -H 'OpenWOP-Version: 2.0' >/dev/null || { echo "host never answered discovery"; exit 1; }

# ---- preflight: assert the FIELD each scenario reads, not that a process exists
ENT=$(curl -fsS "$IDP/metadata" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).entityID??""))')
[ -n "$ENT" ] || { echo "PREFLIGHT FAIL: synthetic IdP served no entityID at $IDP"; exit 1; }
echo "  idp entityID: $ENT"

NID="preflight-$RANDOM$RANDOM"
SC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/conformance/seams/sample/auth/scim/provision" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'OpenWOP-Version: 2.0' \
  -d "{\"op\":\"create-user\",\"externalId\":\"$NID\",\"idpUrl\":\"$IDP\"}")
[ "$SC" = "201" ] || { echo "PREFLIGHT FAIL: scim provision answered $SC (want 201)"; exit 1; }
echo "  scim provision: $SC"

LINKED=$(curl -s -X POST "$BASE/conformance/seams/sample/auth/saml/validate" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'OpenWOP-Version: 2.0' \
  -d "{\"idpUrl\":\"$IDP\",\"variant\":\"valid\",\"nameId\":\"$NID\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).link?1:0)}catch{console.log(0)}})')
[ "$LINKED" = "1" ] || { echo "PREFLIGHT FAIL: saml validate carried no \`link\` — v2-subject-link-record would record \`blocked\`"; exit 1; }
echo "  saml validate carries link: $LINKED"

if [ -n "${PREFLIGHT_ONLY:-}" ]; then echo "preflight only — every fixture answered"; exit 0; fi

# ---- cut
OPENWOP_TEST_SAML_IDP_URL="$IDP" \
OPENWOP_TEST_SCIM_URL="urn:openwop:conformance:scim" \
OPENWOP_TEST_IMPLEMENTED_CHANGE_ID="rfc-0176-witness" \
npx openwop-conformance --base-url "$BASE" --api-key "$KEY" \
  --target-major 2 --require-behavior --max-workers 1 \
  --certify "$OUT" --bundle-version 3 --host-build "commit:$SHA" \
  --signing-key keys/host.pem --signing-key-id v2-reference-3

node -e '
const b=require("fs").readFileSync(process.argv[1],"utf8"),j=JSON.parse(b);
const t=j.results.totals, bad=j.claimedProfiles.filter(p=>!p.certified);
console.log(`suite ${j.suite.version} | ${JSON.stringify(t)} | witness ${j.witnessSha256.slice(0,12)}`);
if(t.blocked>0||t.executedFail>0||bad.length) { console.error("NOT CERTIFIED:", bad.map(p=>p.id).join(", ")||"blocked/failed rows"); process.exit(1); }
console.log("all profiles certified");
' "$OUT"
