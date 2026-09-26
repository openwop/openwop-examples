#!/usr/bin/env bash
# The CERTIFYING cut: front every suite fixture publicly, keep the host's egress
# guard CLOSED, relax nothing. Wraps `PUBLIC=1 ./scripts/cut-bundle.sh`.
#
# THIS OPENS PUBLIC INGRESS TO THIS MACHINE for the duration of the cut - four
# Cloudflare quick tunnels, each forwarding one pinned loopback port:
#
#   3841  the suite's webhook receiver AND the RFC 0158 effect receiver
#         (both honour OPENWOP_WEBHOOK_RECEIVER_PORT; the certification setting
#          is --max-workers 1, so the pinned port is never contended)
#   3842  the A2A fake peer
#   3843  the MCP fake server
#   3839  the synthetic IdP
#
# What is exposed is test fixtures that answer canned data, for a few minutes,
# at unguessable *.trycloudflare.com names. It is still ingress, and opening it
# is an OPERATOR DECISION EACH TIME - do not run this from automation, and do not
# assume a previous approval carries. Every tunnel is torn down on exit, however
# the script exits.
#
#   ./scripts/cut-public.sh [outfile=bundle-v3.json.new]
#
# Requires: cloudflared on PATH, keys/host.pem, the suite installed (>= 2.33.0 -
# older suites have no public front for the A2A / MCP fakes).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-bundle-v3.json.new}"
command -v cloudflared >/dev/null || { echo "cloudflared is not on PATH"; exit 1; }

RX_PORT=3841; A2A_PORT=3842; MCP_PORT=3843; IDP_PORT="${IDP_PORT:-3839}"
# RFC 0199/0200 (suite 2.36.0+) added three suite-owned doubles the host must reach
# through a CLOSED guard: the authorization server, a second AS that a PRM may name
# as a foreign issuer, and the protected-resource double. They were not fronted, so
# the 2026-09-23 cut recorded seven RFC 0199 rows executed-fail on their POSITIVE
# controls (the host could not complete a genuine grant) and four discovery rows
# blocked. Nothing was wrong with the host; the fixtures were simply unreachable.
AS_PORT=3844; AS2_PORT=3845; RES_PORT=3846
# The host itself (cut-bundle.sh PORT). RFC 0199 §C.2: a credential interrupt's
# connectUrl is on the host's own https origin, so the host needs a public front
# to advertise oauth.credentialInterrupt; the suite still drives loopback.
HOST_PORT=3838
LOGDIR="$(mktemp -d -t v2ref-tunnels.XXXXXX)"
PIDS=()
PORTS=("$RX_PORT" "$A2A_PORT" "$MCP_PORT" "$IDP_PORT" "$AS_PORT" "$AS2_PORT" "$RES_PORT" "$HOST_PORT")
# TEARDOWN IS THE CONDITION THIS SCRIPT IS ALLOWED TO RUN UNDER, so it is done
# three ways and then CHECKED. The first version of this script recorded each
# tunnel's pid inside `$(open_tunnel ...)` - a SUBSHELL - so the parent's PIDS
# was always empty, the trap killed nothing, and three tunnels outlived the cut
# (measured on its first run; killed by hand). A pid list is not trusted alone.
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for port in "${PORTS[@]}"; do pkill -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:${port}\$" 2>/dev/null || true; pkill -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:${port} " 2>/dev/null || true; done
  sleep 1
  local left; left="$(pgrep -f 'cloudflared tunnel --no-autoupdate --url http://127.0.0.1:38' || true)"
  if [ -n "$left" ]; then
    echo "!!! TUNNELS STILL UP after teardown (pids: $left) - killing with SIGKILL" >&2
    echo "$left" | xargs kill -9 2>/dev/null || true; sleep 1
    left="$(pgrep -f 'cloudflared tunnel --no-autoupdate --url http://127.0.0.1:38' || true)"
    [ -z "$left" ] || echo "!!! PUBLIC INGRESS IS STILL OPEN - pids $left - kill them by hand NOW" >&2
  fi
  [ -z "${left:-}" ] && echo "tunnels closed and verified closed (logs: $LOGDIR)"
}
trap cleanup EXIT

# open_tunnel <name> <port>  ->  sets TUNNEL_URL. Called DIRECTLY, never in $( ):
# the pid must be recorded in THIS shell or the trap cannot see it.
TUNNEL_URL=""
open_tunnel() {
  local name="$1" port="$2" log="$LOGDIR/$1.log"
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${port}" >"$log" 2>&1 &
  PIDS+=("$!")
  TUNNEL_URL=""
  for _ in $(seq 1 60); do
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$TUNNEL_URL" ] && break
    sleep 1
  done
  [ -n "$TUNNEL_URL" ] || { echo "tunnel $name (port $port) never reported a URL - see $log" >&2; exit 1; }
}

echo "opening seven public tunnels..."
open_tunnel receiver "$RX_PORT"; RX_URL="$TUNNEL_URL"
open_tunnel a2a "$A2A_PORT";      A2A_URL="$TUNNEL_URL"
open_tunnel mcp "$MCP_PORT";      MCP_URL="$TUNNEL_URL"
open_tunnel idp "$IDP_PORT";      IDP_URL="$TUNNEL_URL"
open_tunnel as "$AS_PORT";        AS_URL="$TUNNEL_URL"
open_tunnel as2 "$AS2_PORT";      AS2_URL="$TUNNEL_URL"
open_tunnel resource "$RES_PORT"; RES_URL="$TUNNEL_URL"
open_tunnel host "$HOST_PORT";     HOST_URL="$TUNNEL_URL"
# A quick tunnel's name is not resolvable the instant cloudflared prints it. The
# first run of this script handed the host an IdP URL seconds old, the host's
# resolver answered ENOTFOUND, and the SCIM preflight read 500. curl exit 6 is
# "could not resolve host"; any HTTP answer at all (Cloudflare's 502/530 for a
# listener that is not up yet included) means the NAME is live.
#
# AND THE FIRST LOOKUP MUST NOT COME TOO EARLY. Measured 2026-09-21, two cuts
# running: a name was looked up before its A record had propagated, the recursive
# resolver (Google, 8.8.8.8) cached the EMPTY answer, and trycloudflare.com's SOA
# sets the negative TTL to 1800 s. The name then answered AAAA but no A for half
# an hour; this machine has no IPv6 route, so getaddrinfo returned nothing and
# curl exited 6 for the whole 90 s wait - with three healthy tunnels open beside
# it. Retrying cannot outlast a 30-minute negative cache. So: (1) let the names
# SETTLE before anything asks for them; (2) ask a DIFFERENT resolver first
# (Cloudflare over HTTPS - a cache the host never reads), so an early miss
# poisons nothing the cut depends on; (3) only then touch the system resolver,
# and if IT says no while the other says yes, name the poisoned cache and stop
# at once rather than hold ingress open for a wait that cannot succeed.
SETTLE_SECONDS="${SETTLE_SECONDS:-30}"
doh_has_a() {
  curl -s --max-time 5 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$1&type=A" 2>/dev/null | grep -q '"type":1,'
}
wait_resolves() {
  local url="$1" host rc
  host="${url#https://}"
  for _ in $(seq 1 60); do doh_has_a "$host" && break; sleep 2; done
  doh_has_a "$host" || { echo "public name has no A record after 120 s (asked Cloudflare DoH): $url" >&2; exit 1; }
  for _ in $(seq 1 10); do
    rc=0; curl -s -o /dev/null --max-time 5 "$url" || rc=$?
    [ "$rc" -ne 6 ] && return 0
    sleep 2
  done
  echo "the SYSTEM resolver cannot resolve $url although its A record exists - a negatively-cached early lookup (negative TTL 1800 s). Waiting will not help; re-run, and the new tunnels get new names." >&2; exit 1
}
echo "letting the seven names settle for ${SETTLE_SECONDS}s before anything looks them up..."
sleep "$SETTLE_SECONDS"
for u in "$RX_URL" "$A2A_URL" "$MCP_URL" "$IDP_URL" "$AS_URL" "$AS2_URL" "$RES_URL"; do wait_resolves "$u"; done
echo "all seven public names resolve"
[ "${#PIDS[@]}" -eq 7 ] || { echo "expected 7 tunnel pids recorded in this shell, have ${#PIDS[@]} - refusing to continue with ingress the trap cannot close" >&2; exit 1; }
printf '  receiver %s -> :%s\n  a2a      %s -> :%s\n  mcp      %s -> :%s\n  idp      %s -> :%s\n  as       %s -> :%s\n  as2      %s -> :%s\n  resource %s -> :%s\n' "$RX_URL" "$RX_PORT" "$A2A_URL" "$A2A_PORT" "$MCP_URL" "$MCP_PORT" "$IDP_URL" "$IDP_PORT" "$AS_URL" "$AS_PORT" "$AS2_URL" "$AS2_PORT" "$RES_URL" "$RES_PORT"

# The receiver front carries a path; the fakes and the IdP are bare origins.
PUBLIC=1 IDP_PORT="$IDP_PORT" IDP_PUBLIC_URL="$IDP_URL" \
OPENWOP_WEBHOOK_RECEIVER_URL="${RX_URL}/hook" OPENWOP_WEBHOOK_RECEIVER_PORT="$RX_PORT" \
OPENWOP_A2A_FAKE_PEER_URL="$A2A_URL" OPENWOP_A2A_FAKE_PEER_PORT="$A2A_PORT" \
OPENWOP_MCP_FAKE_SERVER_URL="$MCP_URL" OPENWOP_MCP_FAKE_SERVER_PORT="$MCP_PORT" \
OPENWOP_OAUTH_AS_URL="$AS_URL" OPENWOP_OAUTH_AS_PORT="$AS_PORT" \
OPENWOP_OAUTH_AS2_URL="$AS2_URL" OPENWOP_OAUTH_AS2_PORT="$AS2_PORT" \
OPENWOP_OAUTH_RESOURCE_URL="$RES_URL" OPENWOP_OAUTH_RESOURCE_PORT="$RES_PORT" \
OPENWOP_HOST_PUBLIC_URL="$HOST_URL" \
  ./scripts/cut-bundle.sh "$OUT"
