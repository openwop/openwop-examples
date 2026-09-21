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
LOGDIR="$(mktemp -d -t v2ref-tunnels.XXXXXX)"
PIDS=()
PORTS=("$RX_PORT" "$A2A_PORT" "$MCP_PORT" "$IDP_PORT")
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

echo "opening four public tunnels..."
open_tunnel receiver "$RX_PORT"; RX_URL="$TUNNEL_URL"
open_tunnel a2a "$A2A_PORT";      A2A_URL="$TUNNEL_URL"
open_tunnel mcp "$MCP_PORT";      MCP_URL="$TUNNEL_URL"
open_tunnel idp "$IDP_PORT";      IDP_URL="$TUNNEL_URL"
# A quick tunnel's name is not resolvable the instant cloudflared prints it. The
# first run of this script handed the host an IdP URL seconds old, the host's
# resolver answered ENOTFOUND, and the SCIM preflight read 500. curl exit 6 is
# "could not resolve host"; any HTTP answer at all (Cloudflare's 502/530 for a
# listener that is not up yet included) means the NAME is live.
wait_resolves() {
  local url="$1" rc
  for _ in $(seq 1 90); do
    rc=0; curl -s -o /dev/null --max-time 5 "$url" || rc=$?
    [ "$rc" -ne 6 ] && return 0
    sleep 1
  done
  echo "public name never resolved: $url" >&2; exit 1
}
for u in "$RX_URL" "$A2A_URL" "$MCP_URL" "$IDP_URL"; do wait_resolves "$u"; done
echo "all four public names resolve"
[ "${#PIDS[@]}" -eq 4 ] || { echo "expected 4 tunnel pids recorded in this shell, have ${#PIDS[@]} - refusing to continue with ingress the trap cannot close" >&2; exit 1; }
printf '  receiver %s -> :%s\n  a2a      %s -> :%s\n  mcp      %s -> :%s\n  idp      %s -> :%s\n' "$RX_URL" "$RX_PORT" "$A2A_URL" "$A2A_PORT" "$MCP_URL" "$MCP_PORT" "$IDP_URL" "$IDP_PORT"

# The receiver front carries a path; the fakes and the IdP are bare origins.
PUBLIC=1 IDP_PORT="$IDP_PORT" IDP_PUBLIC_URL="$IDP_URL" \
OPENWOP_WEBHOOK_RECEIVER_URL="${RX_URL}/hook" OPENWOP_WEBHOOK_RECEIVER_PORT="$RX_PORT" \
OPENWOP_A2A_FAKE_PEER_URL="$A2A_URL" OPENWOP_A2A_FAKE_PEER_PORT="$A2A_PORT" \
OPENWOP_MCP_FAKE_SERVER_URL="$MCP_URL" OPENWOP_MCP_FAKE_SERVER_PORT="$MCP_PORT" \
  ./scripts/cut-bundle.sh "$OUT"
