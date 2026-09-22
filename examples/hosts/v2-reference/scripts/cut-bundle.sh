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
# The second tenant (RFC 0202 identical-refusal / tenant-of-record, RFC 0208 a2a-list-scoped, RFC 0198
# and 0205 cross-tenant legs): the host binds it, the suite presents it. Without it those rows are `blocked`.
KEY_B="${OPENWOP_TENANT_B_API_KEY:-openwop-v2-dev-key-tenant-b}"
IDP_PORT="${IDP_PORT:-3839}"
IDP="http://127.0.0.1:${IDP_PORT}"   # where THIS SCRIPT reaches the IdP; the HOST is told $IDP_FOR_HOST

# ---- TWO POSTURES, and only one of them certifies -----------------------------
# security-defaults.md §Relaxations: every relaxation a host runs under MUST be
# recorded in host.relaxations[], and a relaxed obligation's profile MUST NOT
# certify. Until 2026-09-21 this script ran the host with its egress guard open
# (every suite fixture is a loopback listener) and recorded NOTHING - so every
# bundle it produced said `certified: true` under an undeclared relaxation
# (openwop docs/KNOWN-LIMITS.md). Found by the steward, on the steward's host.
#
#   PUBLIC=1   THE CERTIFYING CUT. The guard stays CLOSED. Every fixture the host
#              must reach is fronted publicly (https, a tunnel) and its listener
#              pinned to a port the front forwards to. Requires, per fixture:
#                OPENWOP_WEBHOOK_RECEIVER_URL + OPENWOP_WEBHOOK_RECEIVER_PORT
#                OPENWOP_A2A_FAKE_PEER_URL    + OPENWOP_A2A_FAKE_PEER_PORT
#                OPENWOP_MCP_FAKE_SERVER_URL  + OPENWOP_MCP_FAKE_SERVER_PORT
#                IDP_PUBLIC_URL               (fronting IDP_PORT)
#              Nothing is declared because nothing is relaxed, and the suite
#              checks it: `v2-webhook-egress-refusal` registers eight
#              destinations the guard MUST refuse and fails if one is accepted.
#
#   (default)  THE REGRESSION LANE. Loopback fixtures, guard open, and the
#              relaxation DECLARED - so `openwop-core-standard` (built on
#              `webhooks`) honestly does NOT certify. A green run here means the
#              host still behaves; it is never evidence, and this script says so
#              instead of printing "all profiles certified".
PUBLIC="${PUBLIC:-}"
if [ -n "$PUBLIC" ]; then
  for v in OPENWOP_WEBHOOK_RECEIVER_URL OPENWOP_WEBHOOK_RECEIVER_PORT OPENWOP_A2A_FAKE_PEER_URL OPENWOP_A2A_FAKE_PEER_PORT OPENWOP_MCP_FAKE_SERVER_URL OPENWOP_MCP_FAKE_SERVER_PORT IDP_PUBLIC_URL; do
    [ -n "${!v:-}" ] || { echo "PUBLIC=1 needs $v - a fixture left on loopback is unreachable through a closed guard and its rows record blocked"; exit 1; }
  done
  ALLOW_PRIVATE=0; RELAXATIONS=''; IDP_FOR_HOST="$IDP_PUBLIC_URL"
  echo "POSTURE: PUBLIC - egress guard CLOSED, no relaxation; this cut can certify"
else
  ALLOW_PRIVATE=1; IDP_FOR_HOST="$IDP"
  RELAXATIONS='[{"obligation":"webhooks.egress-guard","durability":"session","reason":"loopback conformance cut: OPENWOP_WEBHOOK_ALLOW_PRIVATE opens this host egress guard (scheme and private-address refusal) for webhook registration and delivery, the http.fetch effect, SAML/SCIM and A2A/MCP interop, because every suite fixture is a loopback listener"}]'
  echo "POSTURE: LOOPBACK REGRESSION LANE - egress guard OPEN and DECLARED; openwop-core-standard will NOT certify. Use PUBLIC=1 for evidence."
fi
SHA="$(git rev-parse HEAD)"

# RFC 0204 — ctx.mcp's server bindings (conformance/fixtures.md §"The ctx.mcp
# fixture"): `conformance` is the suite's in-process fake MCP server, which the
# host must know BEFORE it boots, so its port is pinned; `conformance.down` is an
# address nothing answers (under PUBLIC the closed guard refuses it outright,
# which is the same transport failure).
MCP_FAKE_PORT="${OPENWOP_MCP_FAKE_SERVER_PORT:-3841}"
MCP_FOR_HOST="${OPENWOP_MCP_FAKE_SERVER_URL:-http://127.0.0.1:${MCP_FAKE_PORT}}"
MCP_SERVERS="conformance=${MCP_FOR_HOST},conformance.down=http://127.0.0.1:9"

cleanup() { [ -n "${HOST_PID:-}" ] && kill "$HOST_PID" 2>/dev/null; [ -n "${IDP_PID:-}" ] && kill "$IDP_PID" 2>/dev/null; true; }
trap cleanup EXIT

# No `npm run build` here: this tsconfig EMITS, and a dist/ tree makes `npx vitest
# run` pick up dist/test/*.js and fail. Typecheck with `npx tsc --noEmit` instead.
# ALLOW_PRIVATE is required, not optional: the suite's webhook receivers and the
# synthetic IdP are both on loopback, and the egress guard refuses them without it.
#
# RFC 0158: the host runs UNDER THE RESTART SUPERVISOR with the durability seam
# mounted, because two of the rung's rows SIGKILL it and a black-box suite cannot
# restart what it killed (§E, operator preconditions). The supervisor counts the
# deaths itself; the verdict below refuses a bundle whose kill rows passed with
# fewer deaths than kill rows, since a green row is otherwise indistinguishable
# from a seam that answered 202 and never died. A FRESH database per cut: the
# kill rows leave nothing behind that a later cut should inherit.
# (The port is OPENWOP_PORT. This script used to pass it positionally, which the
# host has never read — it only worked because 3838 is also the default.)
SUP_LOG="$(mktemp -t v2ref-supervisor.XXXXXX)"
CUT_DB="$(mktemp -d -t v2ref-cut.XXXXXX)/cut.sqlite"
OPENWOP_PORT="$PORT" OPENWOP_DB_PATH="$CUT_DB" OPENWOP_DURABILITY_SEAM=1 \
OPENWOP_WEBHOOK_ALLOW_PRIVATE="$ALLOW_PRIVATE" OPENWOP_IMPLEMENTED_CHANGE_IDS=rfc-0176-witness \
OPENWOP_MCP_SERVERS="$MCP_SERVERS" OPENWOP_TENANT_B_API_KEY="$KEY_B" \
  node scripts/supervisor.mjs --restart-ms 1000 --log "$SUP_LOG" >/tmp/cut-host.log 2>&1 &
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

# Wait for the IdP too. This script only ever waited for the HOST, and got away
# with it because `npx tsx` made the host the slower of the two to boot. Under
# the supervisor the host is up first, and the preflight below curled an IdP
# that had not bound its port yet — a refusal that read as a broken fixture.
for _ in $(seq 1 30); do curl -fsS "$IDP/metadata" >/dev/null 2>&1 && break; sleep 1; done

# PUBLIC posture: prove the IdP front FORWARDS before the host is told to use it.
# A name that resolves is not a tunnel that forwards; the edge can answer 502/530
# for some seconds after the listener comes up.
if [ -n "$PUBLIC" ]; then
  for _ in $(seq 1 60); do curl -fsS --max-time 5 "$IDP_FOR_HOST/metadata" 2>/dev/null | grep -q entityID && break; sleep 1; done
  curl -fsS --max-time 5 "$IDP_FOR_HOST/metadata" | grep -q entityID || { echo "PREFLIGHT FAIL: the IdP public front $IDP_FOR_HOST never forwarded /metadata"; exit 1; }
  echo "  idp public front forwards: $IDP_FOR_HOST"
fi

# ---- preflight: assert the FIELD each scenario reads, not that a process exists
ENT=$(curl -fsS "$IDP/metadata" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).entityID??""))')
[ -n "$ENT" ] || { echo "PREFLIGHT FAIL: synthetic IdP served no entityID at $IDP"; exit 1; }
echo "  idp entityID: $ENT"

NID="preflight-$RANDOM$RANDOM"
SC=$(curl -s -o /tmp/cut-scim-preflight.json -w '%{http_code}' -X POST "$BASE/conformance/seams/sample/auth/scim/provision" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'OpenWOP-Version: 2.0' \
  -d "{\"op\":\"create-user\",\"externalId\":\"$NID\",\"idpUrl\":\"$IDP_FOR_HOST\"}")
[ "$SC" = "201" ] || { echo "PREFLIGHT FAIL: scim provision answered $SC (want 201): $(head -c 600 /tmp/cut-scim-preflight.json)"; exit 1; }
echo "  scim provision: $SC"

LINKED=$(curl -s -X POST "$BASE/conformance/seams/sample/auth/saml/validate" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'OpenWOP-Version: 2.0' \
  -d "{\"idpUrl\":\"$IDP_FOR_HOST\",\"variant\":\"valid\",\"nameId\":\"$NID\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).link?1:0)}catch{console.log(0)}})')
[ "$LINKED" = "1" ] || { echo "PREFLIGHT FAIL: saml validate carried no \`link\` — v2-subject-link-record would record \`blocked\`"; exit 1; }
echo "  saml validate carries link: $LINKED"

# The A2A / MCP fakes are started IN-PROCESS by the suite, opt-in on these env
# names — a cut without them records `blocked` on the negotiation and MRTR rows,
# not `inapplicable`, because the host advertises the families. Assert discovery
# really advertises them, so the two halves can never drift apart silently.
FAM=$(curl -fsS "$BASE/.well-known/openwop" -H 'OpenWOP-Version: 2.0' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s),c=d.capabilities??d;console.log(["a2a","mcp"].filter(k=>k in c).join(","))})')
[ "$FAM" = "a2a,mcp" ] || { echo "PREFLIGHT FAIL: discovery advertises \"$FAM\", want a2a,mcp — the interop rows would record blocked"; exit 1; }
echo "  discovery advertises: $FAM (suite fakes enabled in-process)"

if [ -n "${PREFLIGHT_ONLY:-}" ]; then echo "preflight only — every fixture answered"; exit 0; fi

# ---- cut
# Strict mode (--require-behavior, wired in suite 2.4.5 — before that the flag
# was a silent no-op) demands that every capability-gated scenario either find
# its family ADVERTISED or find an explicit opt-out. Three families this host
# deliberately does not implement, declared here rather than left to soft-skip:
#   family.forms   — obliges field validation and i18n labels at a form-bearing
#                    surface this host does not have (the ninth host-tier id).
#   family.memory  — no agent-memory layer.
#   connections.packsSupported — no connection-provider surface.
# An opt-out is a CLAIM, not a hiding place: it appears in the bundle.
OPENWOP_OPTED_OUT_PROFILES=family.forms,family.memory,connections.packsSupported \
OPENWOP_A2A_FAKE_PEER=true OPENWOP_A2A_FAKE_PEER_VERSIONS=1.0,0.3 \
OPENWOP_MCP_FAKE_SERVER=true OPENWOP_MCP_FAKE_SERVER_PORT="$MCP_FAKE_PORT" \
OPENWOP_TEST_SAML_IDP_URL="$IDP_FOR_HOST" \
OPENWOP_HOST_RELAXATIONS="$RELAXATIONS" \
OPENWOP_TEST_SCIM_URL="urn:openwop:conformance:scim" \
OPENWOP_TEST_IMPLEMENTED_CHANGE_ID="rfc-0176-witness" \
OPENWOP_TEST_TENANT_B_API_KEY="$KEY_B" \
npx openwop-conformance --base-url "$BASE" --api-key "$KEY" \
  --target-major 2 --require-behavior --max-workers 1 \
  --certify "$OUT" --bundle-version 3 --host-build "commit:$SHA" \
  --signing-key keys/host.pem --signing-key-id v2-reference-4

node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")), pub=process.argv[2]==="1";
const t=j.results.totals, bad=j.claimedProfiles.filter(p=>!p.certified).map(p=>p.id);
console.log(`suite ${j.suite.version} | ${JSON.stringify(t)} | witness ${j.witnessSha256.slice(0,12)} | relaxations ${JSON.stringify((j.host.relaxations||[]).map(r=>r.obligation))}`);
if(t.blocked>0||t.executedFail>0) { console.error("NOT CLEAN: blocked/failed rows"); process.exit(1); }
if(pub) {
  if((j.host.relaxations||[]).length) { console.error("PUBLIC cut recorded a relaxation - it must record none"); process.exit(1); }
  if(bad.length) { console.error("NOT CERTIFIED:", bad.join(", ")); process.exit(1); }
  console.log("all profiles certified, guard closed, nothing relaxed - THIS BUNDLE IS EVIDENCE");
} else {
  if(!(j.host.relaxations||[]).length) { console.error("loopback cut recorded NO relaxation - refusing: that is the defect this script had"); process.exit(1); }
  if(!bad.includes("openwop-core-standard")) { console.error("loopback cut certified openwop-core-standard under a declared webhooks relaxation - the suite is older than 2.33.0 or the rule regressed"); process.exit(1); }
  console.log(`REGRESSION LANE GREEN - not certified by design: ${bad.join(", ")}. NOT EVIDENCE. Do not commit this bundle as bundle-v3.json.`);
}
' "$OUT" "${PUBLIC:+1}"

# ---- RFC 0158: the deaths are counted by the thing that watched them happen
DEATHS=$(grep -c '"event":"died"' "$SUP_LOG" || true)
KILL_PASSES=$(node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
console.log(j.results.requirements.filter(r=>/\.0158\.kill-(after-accept|during-execution)$/.test(r.id)&&r.result==="executed-pass").length);' "$OUT")
echo "RFC 0158: kill rows executed-pass = $KILL_PASSES; SIGKILL deaths the supervisor observed = $DEATHS ($SUP_LOG)"
if [ "$DEATHS" -lt "$KILL_PASSES" ]; then
  echo "REFUSED: $KILL_PASSES kill row(s) passed but the supervisor saw only $DEATHS death(s) — a kill row passed without a process dying (RFC 0158 §D.9)"; exit 1
fi
node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
for (const r of j.results.requirements.filter(r=>r.id.includes(".0158."))) console.log("  ", r.id.split(".").pop().padEnd(24), r.result, r.detail?`— ${r.detail.slice(0,120)}`:"");' "$OUT"
