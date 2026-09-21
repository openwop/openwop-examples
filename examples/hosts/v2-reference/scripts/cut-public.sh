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
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; echo "tunnels closed (logs: $LOGDIR)"; }
trap cleanup EXIT

# open <name> <port>  ->  prints the https URL once the tunnel reports it
open_tunnel() {
  local name="$1" port="$2" log="$LOGDIR/$1.log" url=""
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${port}" >"$log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 60); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  [ -n "$url" ] || { echo "tunnel $name (port $port) never reported a URL - see $log" >&2; exit 1; }
  echo "$url"
}

echo "opening four public tunnels..."
RX_URL="$(open_tunnel receiver "$RX_PORT")"
A2A_URL="$(open_tunnel a2a "$A2A_PORT")"
MCP_URL="$(open_tunnel mcp "$MCP_PORT")"
IDP_URL="$(open_tunnel idp "$IDP_PORT")"
printf '  receiver %s -> :%s\n  a2a      %s -> :%s\n  mcp      %s -> :%s\n  idp      %s -> :%s\n' "$RX_URL" "$RX_PORT" "$A2A_URL" "$A2A_PORT" "$MCP_URL" "$MCP_PORT" "$IDP_URL" "$IDP_PORT"

# The receiver front carries a path; the fakes and the IdP are bare origins.
PUBLIC=1 IDP_PORT="$IDP_PORT" IDP_PUBLIC_URL="$IDP_URL" \
OPENWOP_WEBHOOK_RECEIVER_URL="${RX_URL}/hook" OPENWOP_WEBHOOK_RECEIVER_PORT="$RX_PORT" \
OPENWOP_A2A_FAKE_PEER_URL="$A2A_URL" OPENWOP_A2A_FAKE_PEER_PORT="$A2A_PORT" \
OPENWOP_MCP_FAKE_SERVER_URL="$MCP_URL" OPENWOP_MCP_FAKE_SERVER_PORT="$MCP_PORT" \
  ./scripts/cut-bundle.sh "$OUT"
