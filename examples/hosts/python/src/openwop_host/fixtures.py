"""The workflows this host can run: the conformance fixtures whose semantics it
honours end to end.

They are read from `OPENWOP_FIXTURES_DIR` when set (point it at an installed
`@openwop/openwop-conformance/fixtures` to pick up a newer catalog), then from
the copies vendored in `fixtures/` beside this package, so the host runs with
no npm install. Only the ids in `HONOURED` whose every node type is in
`EXECUTABLE` are loaded, so `fixtures[]` in discovery is exactly what can run.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

HONOURED = frozenset(
    {
        "conformance-noop",
        "conformance-delay",
        "conformance-cancellable",
        "conformance-multi-node",
        "conformance-failure",
        "conformance-approval",
        "conformance-clarification",
        "conformance-interrupt-external-event",
        "conformance-idempotent",
    }
)
EXECUTABLE = frozenset(
    {
        "core.noop",
        "core.identity",
        "core.delay",
        "core.fail",
        "core.approvalGate",
        "core.clarificationGate",
        "core.interrupt",
    }
)

VENDORED = Path(__file__).resolve().parents[2] / "fixtures"


def load_workflows(extra_dir: str | None) -> dict[str, dict[str, Any]]:
    dirs = [Path(extra_dir)] if extra_dir else []
    dirs.append(VENDORED)
    workflows: dict[str, dict[str, Any]] = {}
    for d in dirs:
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.json")):
            try:
                definition = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            wid = definition.get("id") if isinstance(definition, dict) else None
            if wid not in HONOURED or wid in workflows:
                continue
            nodes = definition.get("nodes")
            if not isinstance(nodes, list) or not all(n.get("typeId") in EXECUTABLE for n in nodes):
                continue
            workflows[wid] = definition
    workflows.setdefault(
        "conformance-noop", {"id": "conformance-noop", "nodes": [{"id": "noop", "typeId": "core.noop"}]}
    )
    approval = workflows.get("conformance-approval")
    if approval is not None:
        # approver enforcement: the same gate, eligible only to a principal the caller is not.
        variant = copy.deepcopy(approval)
        variant["id"] = "conformance-approval-approvers"
        gate = variant["nodes"][0]
        gate["config"] = {**(gate.get("config") or {}), "approversList": ["urn:conformance:listed-approver"]}
        workflows[variant["id"]] = variant
    return workflows


def fixtures_dir_from_env() -> str | None:
    return os.environ.get("OPENWOP_FIXTURES_DIR") or None
