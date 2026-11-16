# Sourced by cut-public.sh. Bash only, no side effects.
#
# quick_tunnel_url <cloudflared-log>  ->  prints the tunnel's public URL, or nothing.
# A cloudflared quick tunnel announces one random multi-word name under
# trycloudflare.com (e.g. https://solved-edges-alex-inn.trycloudflare.com). Its
# error lines name other trycloudflare.com URLs too, its own API among them: when
# the tunnel request times out the log reads
#   failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": ...
# and taking the first URL in the log handed a dead tunnel to the cut as the
# OAuth authorization server (2026-11-16: 18 failures, an uncertified bundle).
# A failed request prints nothing here, and so does any name not of the
# quick-tunnel shape.
quick_tunnel_url() {
  local log="$1"
  grep -q 'failed to request quick Tunnel' "$log" 2>/dev/null && return 0
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" 2>/dev/null | while read -r u; do
    valid_tunnel_url "$u" && { echo "$u"; break; }
  done
}

# valid_tunnel_url <url>  ->  exit 0 iff the URL has the quick-tunnel shape: at
# least three hyphen-joined lowercase words as the ONLY label under
# trycloudflare.com, and none of cloudflared's own service names.
valid_tunnel_url() {
  local u="$1" label
  [[ "$u" =~ ^https://([a-z0-9]+(-[a-z0-9]+){2,})\.trycloudflare\.com$ ]] || return 1
  label="${BASH_REMATCH[1]}"
  case "$label" in api|api-*|www|www-*) return 1 ;; esac
  return 0
}
