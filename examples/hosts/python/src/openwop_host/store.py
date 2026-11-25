"""Storage: one SQLite file (stdlib `sqlite3`), one connection, one lock.

persistence.md §Durable acceptance — a host that returns success for work it
accepted MUST have made it durable first, and MUST resume accepted work after
the accepting process dies. So a run, its events, its interrupts and the
idempotency records are rows, written before the response that reports them;
on boot every non-terminal run that is not waiting on a caller re-enters the
executor (see `executor.Executor.resume_unfinished`).

Single process: there is no claim or lease, so two processes MUST NOT share a
file (the SQLite host, `examples/hosts/sqlite`, shows claim-based dispatch).
`:memory:` gives a throwaway database for tests.

Every read and write goes through this class, under `self.lock`. Writers that
append an event also notify `self.changed`, which the poll and SSE readers wait
on so they wake as soon as the log grows.
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import threading
from typing import Any

from .contract import ENGINE_VERSION, ERA, EVENT_SCHEMA_VERSION, EVENT_TYPES, now_iso, opaque

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,           -- tenant-bound: <tenant>/<opaque>
  tenant TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  owner_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  error_json TEXT,
  current_node_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  pause_requested TEXT,
  parent_run_id TEXT,
  fork_mode TEXT,
  from_seq INTEGER,
  scope_id TEXT,
  engine_version INTEGER NOT NULL,
  event_log_schema_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_tenant_created ON runs(tenant, created_at);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  node_id TEXT,
  payload_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  engine_version INTEGER,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS interrupts (
  interrupt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  ikey TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,              -- open | resolved | invalidated
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, ikey)
);
CREATE TABLE IF NOT EXISTS idempotency (
  tenant TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  status INTEGER,                   -- NULL while the first request is in flight
  headers_json TEXT,
  body TEXT,
  stored_at INTEGER NOT NULL,
  PRIMARY KEY (tenant, endpoint, idem_key)
);
CREATE TABLE IF NOT EXISTS host_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

RUN_COLUMNS = frozenset(
    {
        "status",
        "started_at",
        "ended_at",
        "error_json",
        "current_node_id",
        "cancel_requested",
        "cancel_reason",
        "pause_requested",
    }
)


def _dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


class Store:
    def __init__(self, path: str) -> None:
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.lock = threading.RLock()
        self.changed = threading.Condition()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        if path != ":memory:":
            self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = NORMAL")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        with self.lock:
            self.db.close()

    def _one(self, sql: str, *args: Any) -> dict[str, Any] | None:
        with self.lock:
            row = self.db.execute(sql, args).fetchone()
        return dict(row) if row is not None else None

    def _all(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def _run(self, sql: str, *args: Any) -> int:
        with self.lock:
            return self.db.execute(sql, args).rowcount

    def notify(self) -> None:
        with self.changed:
            self.changed.notify_all()

    def wait_for_change(self, timeout: float) -> None:
        with self.changed:
            self.changed.wait(timeout)

    # ─── Secrets ──────────────────────────────────────────────────────────
    def secret(self, name: str) -> str:
        """A MAC key that survives a restart, so tokens and cursors stay valid."""
        with self.lock:
            self._run("INSERT OR IGNORE INTO host_secrets (name, value) VALUES (?, ?)", name, secrets.token_hex(32))
            row = self._one("SELECT value FROM host_secrets WHERE name = ?", name)
        assert row is not None
        return str(row["value"])

    # ─── Runs ─────────────────────────────────────────────────────────────
    def insert_run(
        self,
        *,
        run_id: str,
        tenant: str,
        workflow_id: str,
        inputs: Any,
        options: Any,
        owner: Any,
        parent_run_id: str | None = None,
        fork_mode: str | None = None,
        from_seq: int | None = None,
        scope_id: str | None = None,
    ) -> dict[str, Any]:
        self._run(
            """INSERT INTO runs (run_id, tenant, workflow_id, status, inputs_json, options_json, owner_json, created_at,
                                 parent_run_id, fork_mode, from_seq, scope_id, engine_version, event_log_schema_version)
               VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            run_id,
            tenant,
            workflow_id,
            _dumps(inputs),
            _dumps(options),
            _dumps(owner),
            now_iso(),
            parent_run_id,
            fork_mode,
            from_seq,
            scope_id,
            ENGINE_VERSION,
            ERA,
        )
        run = self.get_run(run_id)
        assert run is not None
        return run

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM runs WHERE run_id = ?", run_id)

    def update_run(self, run_id: str, **patch: Any) -> None:
        if not patch:
            return
        unknown = set(patch) - RUN_COLUMNS
        if unknown:
            raise ValueError(f"not a mutable run column: {sorted(unknown)}")
        cols = ", ".join(f"{k} = ?" for k in patch)
        self._run(f"UPDATE runs SET {cols} WHERE run_id = ?", *patch.values(), run_id)
        self.notify()

    def unfinished_runs(self) -> list[str]:
        rows = self._all("SELECT run_id FROM runs WHERE status IN ('pending', 'running', 'cancelling')")
        return [r["run_id"] for r in rows]

    def active_for_scope(self, tenant: str, scope_id: str) -> bool:
        return (
            self._one(
                "SELECT run_id FROM runs WHERE tenant = ? AND scope_id = ? AND status NOT IN ('completed','failed','cancelled') LIMIT 1",
                tenant,
                scope_id,
            )
            is not None
        )

    def list_runs(
        self, tenant: str, *, limit: int, workflow_id: str | None, status: str | None, after: tuple[str, str] | None
    ) -> list[dict[str, Any]]:
        where = ["tenant = ?"]
        args: list[Any] = [tenant]
        if workflow_id is not None:
            where.append("workflow_id = ?")
            args.append(workflow_id)
        if status is not None:
            where.append("status = ?")
            args.append(status)
        if after is not None:
            where.append("(created_at < ? OR (created_at = ? AND run_id < ?))")
            args.extend([after[0], after[0], after[1]])
        args.append(limit)
        return self._all(
            f"SELECT * FROM runs WHERE {' AND '.join(where)} ORDER BY created_at DESC, run_id DESC LIMIT ?", *args
        )

    # ─── Events ───────────────────────────────────────────────────────────
    def last_sequence(self, run_id: str) -> int:
        row = self._one("SELECT MAX(seq) AS s FROM events WHERE run_id = ?", run_id)
        return -1 if row is None or row["s"] is None else int(row["s"])

    def append_event(
        self, run_id: str, type_: str, payload: dict[str, Any], node_id: str | None = None
    ) -> dict[str, Any]:
        """The one writer. `sequence` is assigned under the lock, so it is gap-free from 0."""
        if type_ not in EVENT_TYPES:
            raise RuntimeError(f"producer refused: {type_} is not a v2 event type this host emits")
        with self.lock:
            seq = self.last_sequence(run_id) + 1
            row = {
                "run_id": run_id,
                "seq": seq,
                "event_id": opaque(),
                "type": type_,
                "node_id": node_id,
                "payload_json": _dumps(payload),
                "timestamp": now_iso(),
                "schema_version": EVENT_SCHEMA_VERSION,
                "engine_version": ENGINE_VERSION,
            }
            self._insert_event(row)
        self.notify()
        return row

    def _insert_event(self, row: dict[str, Any]) -> None:
        self._run(
            """INSERT INTO events (run_id, seq, event_id, type, node_id, payload_json, timestamp, schema_version, engine_version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            row["run_id"],
            row["seq"],
            row["event_id"],
            row["type"],
            row["node_id"],
            row["payload_json"],
            row["timestamp"],
            row["schema_version"],
            row["engine_version"],
        )

    def copy_prefix(self, source_run_id: str, child_run_id: str, before_seq: int) -> None:
        """replay.md — a fork's history is the source's events `< fromSeq`, each with a fresh eventId."""
        with self.lock:
            for row in self.events_after(source_run_id, -1):
                if row["seq"] >= before_seq:
                    break
                self._insert_event({**row, "run_id": child_run_id, "event_id": opaque()})

    def events_after(self, run_id: str, after_seq: int) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC", run_id, after_seq)

    # ─── Interrupts ───────────────────────────────────────────────────────
    def insert_interrupt(
        self, interrupt_id: str, run_id: str, node_id: str, key: str, payload: Any, expires_at: int
    ) -> None:
        self._run(
            """INSERT INTO interrupts (interrupt_id, run_id, node_id, ikey, payload_json, state, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, 'open', ?, ?)""",
            interrupt_id,
            run_id,
            node_id,
            key,
            _dumps(payload),
            expires_at,
            now_iso(),
        )

    def open_interrupt(self, run_id: str, node_id: str) -> dict[str, Any] | None:
        return self._one(
            "SELECT * FROM interrupts WHERE run_id = ? AND node_id = ? AND state = 'open'", run_id, node_id
        )

    def any_interrupt(self, run_id: str, node_id: str) -> bool:
        return (
            self._one("SELECT 1 AS x FROM interrupts WHERE run_id = ? AND node_id = ? LIMIT 1", run_id, node_id)
            is not None
        )

    def interrupt_by_id(self, interrupt_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM interrupts WHERE interrupt_id = ?", interrupt_id)

    def claim_interrupt(self, interrupt_id: str) -> bool:
        """Atomic open -> resolved; exactly one resolver wins."""
        return (
            self._run(
                "UPDATE interrupts SET state = 'resolved' WHERE interrupt_id = ? AND state = 'open'", interrupt_id
            )
            == 1
        )

    def invalidate_interrupts(self, run_id: str) -> None:
        self._run("UPDATE interrupts SET state = 'invalidated' WHERE run_id = ? AND state = 'open'", run_id)

    # ─── Idempotency ──────────────────────────────────────────────────────
    def get_idem(self, tenant: str, endpoint: str, key: str) -> dict[str, Any] | None:
        return self._one(
            "SELECT * FROM idempotency WHERE tenant = ? AND endpoint = ? AND idem_key = ?", tenant, endpoint, key
        )

    def claim_idem(self, tenant: str, endpoint: str, key: str, digest: str, stored_at: int) -> bool:
        return (
            self._run(
                "INSERT OR IGNORE INTO idempotency (tenant, endpoint, idem_key, digest, status, stored_at) VALUES (?, ?, ?, ?, NULL, ?)",
                tenant,
                endpoint,
                key,
                digest,
                stored_at,
            )
            == 1
        )

    def complete_idem(
        self, tenant: str, endpoint: str, key: str, status: int, headers: dict[str, str], body: Any
    ) -> None:
        self._run(
            "UPDATE idempotency SET status = ?, headers_json = ?, body = ? WHERE tenant = ? AND endpoint = ? AND idem_key = ?",
            status,
            _dumps(headers),
            None if body is None else _dumps(body),
            tenant,
            endpoint,
            key,
        )

    def release_idem(self, tenant: str, endpoint: str, key: str) -> None:
        self._run("DELETE FROM idempotency WHERE tenant = ? AND endpoint = ? AND idem_key = ?", tenant, endpoint, key)

    def prune_idem(self, older_than: int) -> None:
        self._run("DELETE FROM idempotency WHERE stored_at < ?", older_than)
