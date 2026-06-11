"""Fixture loader.

Resolution order (mirrors the TypeScript reference hosts so this host
slot-in-replaces them for conformance runs; degraded loading MUST be
visible at boot, never silent):

    1. ``OPENWOP_FIXTURES_DIR`` — explicit operator override.
    2. Upward probe: walk up from this file for ``conformance/fixtures/``
       (examples repo nested inside the spec repo, or a co-located
       conformance checkout).
    3. Sibling-checkout probe: ``<ancestor>/openwop/conformance/fixtures``
       (the spec repo checked out next to this examples repo).

Hosts that don't find the directory register a synthetic noop so
basic discovery scenarios continue to work in standalone runs — and
log a loud warning so the degraded basis is observable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def load_fixtures(start: Path | None = None) -> dict[str, dict[str, Any]]:
    """Return {workflowId: fixture-doc} from the resolved fixtures dir.

    Walks up at most 10 levels from `start` (defaults to this file's
    parent). When no directory is found, returns a single-entry dict
    with a synthetic noop fixture so the host still answers discovery
    + basic lifecycle scenarios.
    """
    origin = (start or Path(__file__).resolve().parent).resolve()

    # 1) Explicit override.
    explicit = os.environ.get("OPENWOP_FIXTURES_DIR")
    if explicit:
        explicit_path = Path(explicit)
        if explicit_path.is_dir():
            loaded = _load_directory(explicit_path)
            if loaded:
                _log_loaded(explicit_path, len(loaded))
                return loaded
        print(
            f"[openwop-host-in-memory-python] fixtures: OPENWOP_FIXTURES_DIR={explicit} "
            "yielded no fixtures; falling back to probes",
            flush=True,
        )

    # 2) Upward probe for `conformance/fixtures/`.
    probe = origin
    for _ in range(10):
        candidate = probe / "conformance" / "fixtures"
        if candidate.is_dir():
            loaded = _load_directory(candidate)
            if loaded:
                _log_loaded(candidate, len(loaded))
                return loaded
        if probe.parent == probe:
            break
        probe = probe.parent

    # 3) Sibling-checkout probe: the spec repo next to this examples repo.
    probe = origin
    for _ in range(10):
        candidate = probe / "openwop" / "conformance" / "fixtures"
        if candidate.is_dir():
            loaded = _load_directory(candidate)
            if loaded:
                _log_loaded(candidate, len(loaded))
                return loaded
        if probe.parent == probe:
            break
        probe = probe.parent

    # Fallback: a synthetic noop so discovery + lifecycle still work.
    print(
        "[openwop-host-in-memory-python] fixtures: no conformance/fixtures directory "
        "found — serving the synthetic noop fixture ONLY. Set OPENWOP_FIXTURES_DIR to "
        "the spec repo's conformance/fixtures for the full catalog.",
        flush=True,
    )
    return {
        "conformance-noop": {
            "id": "conformance-noop",
            "name": "Synthetic Noop",
            "version": "1.0",
            "nodes": [
                {"id": "noop", "typeId": "core.noop", "name": "Noop", "inputs": {}},
            ],
        }
    }


def _log_loaded(path: Path, count: int) -> None:
    print(
        f"[openwop-host-in-memory-python] fixtures: loaded {count} from {path}",
        flush=True,
    )


def _load_directory(path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for entry in sorted(path.iterdir()):
        if not entry.is_file() or entry.suffix != ".json":
            continue
        with entry.open("r", encoding="utf-8") as fh:
            try:
                parsed = json.load(fh)
            except json.JSONDecodeError:
                continue
        wf_id = parsed.get("id")
        if isinstance(wf_id, str):
            out[wf_id] = parsed
    return out
