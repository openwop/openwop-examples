"""CLI entry point: `python -m openwop_host` (with `src` on PYTHONPATH)."""

from __future__ import annotations

import os
import signal
import sys
import threading
from pathlib import Path

from . import __version__
from .contract import PROTOCOL_VERSION
from .fixtures import fixtures_dir_from_env
from .server import HOST_NAME, HostOptions, serve

PKG_ROOT = Path(__file__).resolve().parents[2]


def _env_int(name: str, fallback: int) -> int:
    try:
        n = int(os.environ.get(name, ""))
    except ValueError:
        return fallback
    return n if n > 0 else fallback


def options_from_env() -> HostOptions:
    return HostOptions(
        host=os.environ.get("OPENWOP_HOST", "127.0.0.1"),
        port=_env_int("OPENWOP_PORT", 3840),
        db_path=os.environ.get("OPENWOP_SQLITE_PATH", str(PKG_ROOT / "data" / "openwop-host-python.sqlite")),
        api_key=os.environ.get("OPENWOP_API_KEY", "openwop-python-dev-key"),
        tenant_b_key=os.environ.get("OPENWOP_TENANT2_API_KEY") or None,
        max_run_duration_ms=_env_int("OPENWOP_MAX_RUN_DURATION_MS", 600_000),
        fixtures_dir=fixtures_dir_from_env(),
        log_resume_tokens=os.environ.get("OPENWOP_LOG_RESUME_TOKENS") == "true",
    )


def main() -> int:
    opts = options_from_env()
    server, app, thread, resumed = serve(opts)
    port = server.server_address[1]
    note = f"; resumed {resumed} unfinished run(s)" if resumed else ""
    print(
        f"[{HOST_NAME} {__version__}] listening on http://{opts.host}:{port} "
        f"(OpenWOP {PROTOCOL_VERSION}; db {opts.db_path}; {len(app.workflows)} fixtures{note})",
        flush=True,
    )

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    stop.wait()
    server.shutdown()
    app.close()
    server.server_close()
    thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
