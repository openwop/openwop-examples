"""The executor: runs, interrupts and resume tokens.

The log is the executor's only state. Each step re-folds the run's events, so a
restart, a resolved interrupt and a fork all continue from what is recorded.
Nodes run in topological order; any node failure ends the run. One daemon
thread executes a run at a time (`schedule_run`); a request that changes a run
while its thread is live (cancel, a draining pause) writes a flag on the run
row and the thread acts on it at its next check.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .contract import (
    ENGINE_VERSION,
    TERMINAL,
    WAITING,
    b64url,
    b64url_decode,
    err,
    iso_to_ms,
    now_iso,
    now_ms,
    tenant_bound,
)
from .store import Store

MAX_NODE_EXECUTIONS = 1000
TOKEN_KID = "python-1"
TOKEN_DEFAULT_TTL_MS = 30 * 60_000


class NodeFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class HostClosing(Exception):
    """Raised inside a run thread when the process shuts down: it stops without recording anything."""


@dataclass
class Folded:
    started: bool = False
    started_at: str | None = None
    completed: set[str] = field(default_factory=set)
    outputs: dict[str, dict[str, Any]] = field(default_factory=dict)
    attempts: dict[str, int] = field(default_factory=dict)
    starts: int = 0
    requested: dict[str, str] = field(default_factory=dict)
    resolved: dict[str, dict[str, Any]] = field(default_factory=dict)
    resumed: dict[str, Any] = field(default_factory=dict)
    resolved_count: dict[str, int] = field(default_factory=dict)


def payload_of(row: dict[str, Any]) -> dict[str, Any]:
    p = json.loads(row["payload_json"])
    return p if isinstance(p, dict) else {}


def fold(rows: list[dict[str, Any]]) -> Folded:
    st = Folded()
    for e in rows:
        p = payload_of(e)
        t = e["type"]
        n = e["node_id"] or (p.get("nodeId") if isinstance(p.get("nodeId"), str) else None)
        if t == "run.started":
            st.started = True
            st.started_at = e["timestamp"]
        if n is None:
            continue
        if t == "node.started":
            st.starts += 1
            st.attempts[n] = st.attempts.get(n, 0) + 1
            st.requested.pop(n, None)
            st.resolved.pop(n, None)
            st.resumed.pop(n, None)
        elif t == "interrupt.requested":
            if isinstance(p.get("key"), str):
                st.requested[n] = p["key"]
        elif t == "interrupt.resolved":
            st.requested.pop(n, None)
            st.resolved[n] = p
            st.resolved_count[n] = st.resolved_count.get(n, 0) + 1
        elif t == "node.resumed":
            st.resolved.pop(n, None)
            st.resumed[n] = p.get("resumeValue")
        elif t == "node.completed":
            st.completed.add(n)
            st.outputs[n] = p.get("outputs") or {}
            st.resumed.pop(n, None)
            st.resolved.pop(n, None)
            st.requested.pop(n, None)
    return st


def edges_of(definition: dict[str, Any]) -> list[tuple[str, str]]:
    out = []
    for e in definition.get("edges") or []:
        src = e.get("sourceNodeId", e.get("source", e.get("from", "")))
        dst = e.get("targetNodeId", e.get("target", e.get("to", "")))
        out.append((str(src), str(dst)))
    return out


def topological(definition: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = definition["nodes"]
    by_id = {n["id"]: n for n in nodes}
    indeg = {n["id"]: 0 for n in nodes}
    nxt: dict[str, list[str]] = {}
    for src, dst in edges_of(definition):
        if src in indeg and dst in indeg:
            nxt.setdefault(src, []).append(dst)
            indeg[dst] += 1
    ready = [n["id"] for n in nodes if indeg[n["id"]] == 0]
    out = []
    while ready:
        nid = ready.pop(0)
        out.append(by_id[nid])
        for t in nxt.get(nid, []):
            indeg[t] -= 1
            if indeg[t] == 0:
                ready.append(t)
    return out


def options_of(run: dict[str, Any]) -> dict[str, Any]:
    return json.loads(run["options_json"] or "{}")


def waiting_status(kind: str) -> str:
    return {"external-event": "waiting-external", "clarification": "waiting-input"}.get(kind, "waiting-approval")


def duration_since(started_at: str | None) -> int:
    return max(0, now_ms() - iso_to_ms(started_at)) if started_at else 0


class Executor:
    def __init__(
        self,
        store: Store,
        workflows: dict[str, dict[str, Any]],
        *,
        max_run_duration_ms: int,
        log_resume_tokens: bool,
        host_name: str,
    ) -> None:
        self.store = store
        self.workflows = workflows
        self.max_run_duration_ms = max_run_duration_ms
        self.log_resume_tokens = log_resume_tokens
        self.host_name = host_name
        self.token_secret = store.secret("interrupt-token-hs256")
        self.lock = threading.Lock()
        self.active: set[str] = set()
        self.rewake: set[str] = set()
        self.closing = False

    # ─── Scheduling ───────────────────────────────────────────────────────
    def is_active(self, run_id: str) -> bool:
        with self.lock:
            return run_id in self.active

    def schedule_run(self, run_id: str) -> None:
        """Enter (or re-enter) the loop for a run. One thread per run; a loop still
        unwinding (a pause that a resume overtook, say) re-enters once it exits."""
        with self.lock:
            if self.closing:
                return
            if run_id in self.active:
                self.rewake.add(run_id)
                return
            self.active.add(run_id)
        threading.Thread(target=self._loop, args=(run_id,), name=f"run-{run_id}", daemon=True).start()

    def _loop(self, run_id: str) -> None:
        try:
            self.continue_run(run_id)
        except HostClosing:
            pass
        except Exception as e:  # noqa: BLE001 — a host bug must not kill the process
            print(f"[{self.host_name}] executor {run_id}: {e!r}", flush=True)
        finally:
            with self.lock:
                self.active.discard(run_id)
                again = run_id in self.rewake
                self.rewake.discard(run_id)
            if again:
                self.schedule_run(run_id)

    def resume_unfinished(self) -> int:
        """persistence.md §Durable acceptance — accepted work resumes after the process dies."""
        ids = self.store.unfinished_runs()
        for run_id in ids:
            self.schedule_run(run_id)
        return len(ids)

    def close(self, timeout: float = 5.0) -> None:
        with self.lock:
            self.closing = True
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if not self.active:
                    return
            time.sleep(0.02)

    # ─── Helpers ──────────────────────────────────────────────────────────
    def run(self, run_id: str) -> dict[str, Any]:
        row = self.store.get_run(run_id)
        assert row is not None
        return row

    def events(self, run_id: str) -> list[dict[str, Any]]:
        return self.store.events_after(run_id, -1)

    def append(self, run_id: str, type_: str, payload: dict[str, Any], node_id: str | None = None) -> dict[str, Any]:
        return self.store.append_event(run_id, type_, payload, node_id)

    def recursion_limit(self, run: dict[str, Any]) -> int:
        asked = ((options_of(run).get("configurable") or {}).get("run") or {}).get("recursionLimit")
        if isinstance(asked, int) and not isinstance(asked, bool) and asked > 0:
            return min(asked, MAX_NODE_EXECUTIONS)
        return MAX_NODE_EXECUTIONS

    def run_deadline_ms(self, run: dict[str, Any]) -> int:
        asked = ((options_of(run).get("configurable") or {}).get("run") or {}).get("runTimeoutMs")
        return min(asked if isinstance(asked, int) else self.max_run_duration_ms, self.max_run_duration_ms)

    @staticmethod
    def input_of(run: dict[str, Any], definition: dict[str, Any], node: dict[str, Any], name: str) -> Any:
        inputs = json.loads(run["inputs_json"])
        binding = (node.get("inputs") or {}).get(name)
        if isinstance(binding, dict) and binding.get("type") == "variable" and binding.get("variableName"):
            var = binding["variableName"]
            if inputs.get(var) is not None:
                return inputs[var]
            for v in definition.get("variables") or []:
                if v.get("name") == var:
                    return v.get("defaultValue")
            return None
        if isinstance(binding, dict) and "value" in binding:
            return binding["value"]
        return inputs.get(name, (node.get("config") or {}).get(name))

    def key_run_id(self, run: dict[str, Any]) -> str:
        """A replay fork keys its interrupts on its source (replay.md §Suppression)."""
        r = run
        while r["fork_mode"] == "replay" and r["parent_run_id"] is not None:
            src = self.store.get_run(r["parent_run_id"])
            if src is None:
                break
            r = src
        return r["run_id"]

    def interrupt_for(self, run: dict[str, Any], node: dict[str, Any], visit: int) -> dict[str, Any]:
        """interrupt.md §Re-entry — K derives from the run, the node and the node's visit index."""
        key = f"{self.key_run_id(run)}:{node['id']}:{visit}"
        c = node.get("config") or {}
        if node["typeId"] == "core.approvalGate":
            data: dict[str, Any] = {
                "artifactId": node["id"],
                "artifactType": "conformance-artifact",
                "title": str(c.get("title", f"Approve {node['id']}")),
                "actions": c["actions"] if isinstance(c.get("actions"), list) else ["accept", "reject"],
            }
            if isinstance(c.get("description"), str):
                data["description"] = c["description"]
            if isinstance(c.get("approversList"), list):
                data["approversList"] = c["approversList"]
            return {"kind": "approval", "key": key, "data": data}
        if node["typeId"] == "core.clarificationGate":
            questions = (
                c["questions"]
                if isinstance(c.get("questions"), list)
                else [{"id": "q1", "question": str(c.get("question", "Please clarify"))}]
            )
            return {"kind": "clarification", "key": key, "data": {"questions": questions}}
        payload: dict[str, Any] = {
            "kind": str(c.get("kind", "custom")),
            "key": key,
            "data": c["data"] if isinstance(c.get("data"), dict) else {"customKind": node["id"]},
        }
        if isinstance(c.get("timeoutMs"), (int, float)):
            payload["timeoutMs"] = c["timeoutMs"]
        if isinstance(c.get("resumeSchema"), dict):
            payload["resumeSchema"] = c["resumeSchema"]
        return payload

    def sleep_checked(self, run_id: str, ms: int, deadline_ms: int) -> str:
        """Sleep, checking the run row: a cancel or an immediate pause may arrive at any time."""
        until = now_ms() + ms
        while now_ms() < until:
            if self.closing:
                raise HostClosing()
            fresh = self.store.get_run(run_id)
            if fresh is None or fresh["cancel_requested"] == 1 or fresh["status"] in TERMINAL:
                return "cancelled"
            if fresh["status"] == "paused":
                return "paused"
            if now_ms() > deadline_ms:
                return "timeout"
            time.sleep(max(0.001, min(0.05, (until - now_ms()) / 1000)))
        return "done"

    def execute_node(
        self, run: dict[str, Any], definition: dict[str, Any], node: dict[str, Any], visit: int, deadline_ms: int
    ) -> Any:
        t = node["typeId"]
        if t == "core.noop":
            return {"outputs": {}}
        if t == "core.identity":
            return {"outputs": {k: self.input_of(run, definition, node, k) for k in (node.get("inputs") or {})}}
        if t == "core.delay":
            raw = self.input_of(run, definition, node, "delayMs")
            try:
                ms = int(float(1000 if raw is None else raw))
            except (TypeError, ValueError):
                ms = 0
            ms = max(0, min(60_000, ms))
            r = self.sleep_checked(run["run_id"], ms, deadline_ms)
            return {"outputs": {"sleptMs": ms}} if r == "done" else r
        if t == "core.fail":
            # fixtures.md §core.fail: a vendor code under the reserved `example` org.
            raise NodeFailure(
                "example.conformance_failure",
                str((node.get("config") or {}).get("message", "Intentional conformance failure")),
            )
        if t in ("core.approvalGate", "core.clarificationGate", "core.interrupt"):
            return {"suspend": self.interrupt_for(run, node, visit)}
        raise NodeFailure("capability_required", f"node type {t} is not executed by this host")

    # ─── Terminals ────────────────────────────────────────────────────────
    def finish(self, run_id: str, status: str, error: dict[str, Any] | None) -> None:
        self.store.invalidate_interrupts(run_id)
        self.store.update_run(
            run_id,
            status=status,
            ended_at=now_iso(),
            error_json=None if error is None else json.dumps(error),
            current_node_id=None,
            cancel_requested=0,
            pause_requested=None,
        )

    def fail_run(
        self, run_id: str, error: dict[str, Any], started_at: str | None, failed_node_id: str | None = None
    ) -> None:
        payload: dict[str, Any] = {"error": error, "durationMs": duration_since(started_at)}
        if failed_node_id is not None:
            payload["failedNodeId"] = failed_node_id
        self.append(run_id, "run.failed", payload)
        self.finish(run_id, "failed", error)

    def cancel_now(self, run_id: str, reason: str, started_at: str | None) -> None:
        self.append(
            run_id,
            "run.cancelled",
            {"reason": reason, "cancelledBy": "caller", "durationMs": duration_since(started_at)},
        )
        self.finish(run_id, "cancelled", None)

    def recorded_resolution(self, run: dict[str, Any], key: str) -> dict[str, Any] | None:
        """Find the recorded resolution of K in the run's log, then each replay source's."""
        r: dict[str, Any] | None = run
        while r is not None:
            rows = self.events(r["run_id"])
            suspended = next(
                (e for e in rows if e["type"] == "node.suspended" and payload_of(e).get("key") == key), None
            )
            if suspended is not None:
                iid = payload_of(suspended).get("interruptId")
                resolved = next(
                    (e for e in rows if e["type"] == "interrupt.resolved" and payload_of(e).get("interruptId") == iid),
                    None,
                )
                if resolved is not None:
                    return payload_of(resolved)
            r = self.store.get_run(r["parent_run_id"]) if r["fork_mode"] == "replay" and r["parent_run_id"] else None
        return None

    def apply_resolution(self, run_id: str, node_id: str, resolved: dict[str, Any], started_at: str | None) -> str:
        """What a recorded `interrupt.resolved` does: resume and complete the node, or fail the run on a rejection."""
        if resolved.get("decision") == "rejected":
            error = {"code": "approval_rejected", "message": "the approval was rejected", "retryable": False}
            self.append(run_id, "node.failed", {"nodeId": node_id, "error": error, "attempts": 1}, node_id)
            self.fail_run(run_id, error, started_at, node_id)
            return "failed"
        resume_value = resolved.get("resumeValue")
        resumed: dict[str, Any] = {"nodeId": node_id, "resumeValue": resume_value}
        if isinstance(resolved.get("interruptId"), str):
            resumed["interruptId"] = resolved["interruptId"]
        self.append(run_id, "node.resumed", resumed, node_id)
        self.append(run_id, "node.completed", {"nodeId": node_id, "outputs": {"resumeValue": resume_value}}, node_id)
        return "resumed"

    def mint_token(self, interrupt_id: str, run_id: str, expires_at: int) -> str:
        payload = b64url(
            json.dumps(
                {"i": interrupt_id, "r": run_id, "e": expires_at, "t": "resolve"}, separators=(",", ":")
            ).encode()
        )
        mac = hmac.new(self.token_secret.encode(), f"hs256.{TOKEN_KID}.{payload}".encode(), hashlib.sha256).hexdigest()
        return f"ow2.hs256.{TOKEN_KID}.{payload}.{mac}"

    def suspend(self, run: dict[str, Any], node: dict[str, Any], payload: dict[str, Any]) -> None:
        run_id = run["run_id"]
        interrupt_id = tenant_bound(run["tenant"])
        timeout = payload.get("timeoutMs")
        ttl = (
            min(int(timeout), TOKEN_DEFAULT_TTL_MS)
            if isinstance(timeout, (int, float)) and timeout > 0
            else TOKEN_DEFAULT_TTL_MS
        )
        expires_at = now_ms() + ttl
        self.store.insert_interrupt(interrupt_id, run_id, node["id"], payload["key"], payload, expires_at)
        self.append(run_id, "interrupt.requested", payload, node["id"])
        self.append(
            run_id,
            "node.suspended",
            {"nodeId": node["id"], "interruptId": interrupt_id, "kind": payload["kind"], "key": payload["key"]},
            node["id"],
        )
        self.store.update_run(run_id, status=waiting_status(payload["kind"]), current_node_id=node["id"])
        if self.log_resume_tokens:
            print(
                f"[{self.host_name}] {interrupt_id} awaits resolution; resume token "
                f"{self.mint_token(interrupt_id, run_id, expires_at)}",
                flush=True,
            )

    # ─── The loop ─────────────────────────────────────────────────────────
    def continue_run(self, run_id: str) -> None:
        run = self.run(run_id)
        if run["status"] in TERMINAL or run["status"] == "paused" or run["status"] in WAITING:
            return
        definition = self.workflows.get(run["workflow_id"])
        st = fold(self.events(run_id))
        if definition is None:
            self.fail_run(
                run_id,
                {"code": "not_found", "message": f"workflow {run['workflow_id']} is not registered on this host"},
                st.started_at,
            )
            return
        started_at = st.started_at
        if not st.started:
            options = options_of(run)
            payload: dict[str, Any] = {
                "workflowId": run["workflow_id"],
                "inputs": json.loads(run["inputs_json"]),
                "transport": "rest",
                "engineVersion": ENGINE_VERSION,
                "owner": json.loads(run["owner_json"]),
            }
            if "tags" in options:
                payload["tags"] = options["tags"]
            if "metadata" in options:
                payload["metadata"] = options["metadata"]
            started_at = self.append(run_id, "run.started", payload)["timestamp"]
            self.store.update_run(run_id, status="running", started_at=started_at)
        elif run["status"] == "pending":
            self.store.update_run(run_id, status="running")
        assert started_at is not None
        # A fork's copied prefix carries its source's `run.started`; the child's own clock starts when it was created.
        if run.get("fork_mode") is not None and run.get("created_at") and run["created_at"] > started_at:
            started_at = run["created_at"]
        deadline_ms = iso_to_ms(started_at) + self.run_deadline_ms(run)
        limit = self.recursion_limit(run)
        nodes = topological(definition)
        while True:
            if self.closing:
                raise HostClosing()
            run = self.run(run_id)
            if run["status"] in TERMINAL or run["status"] == "paused":
                return
            st = fold(self.events(run_id))
            if run["cancel_requested"] == 1:
                self.cancel_now(run_id, run["cancel_reason"] or "caller-requested", started_at)
                return
            if run["pause_requested"] is not None:
                self.append(run_id, "run.paused", {"reason": "operator", "drainPolicy": run["pause_requested"]})
                self.store.update_run(run_id, status="paused", pause_requested=None)
                return
            node = next((n for n in nodes if n["id"] not in st.completed), None)
            if node is None:
                break
            nid = node["id"]
            # A fork cut between `node.resumed` and `node.completed` finishes the node from the log.
            if nid in st.resumed:
                self.append(run_id, "node.completed", {"nodeId": nid, "outputs": {"resumeValue": st.resumed[nid]}}, nid)
                continue
            recorded = st.resolved.get(nid)
            requested_key = st.requested.get(nid)
            if recorded is None and requested_key is not None and run["fork_mode"] == "replay":
                replayed = self.recorded_resolution(run, requested_key)
                if replayed is not None:
                    self.append(run_id, "interrupt.resolved", replayed, nid)
                    recorded = replayed
            if recorded is not None:
                if self.apply_resolution(run_id, nid, recorded, started_at) == "failed":
                    return
                continue
            if st.starts >= limit:
                self.append(
                    run_id, "cap.breached", {"kind": "node-executions", "limit": limit, "observed": st.starts + 1}
                )
                self.fail_run(
                    run_id,
                    {
                        "code": "recursion_limit_exceeded",
                        "message": f"starting {nid} would exceed recursionLimit {limit}",
                    },
                    started_at,
                )
                return
            if now_ms() > deadline_ms:
                budget = self.run_deadline_ms(run)
                observed = max(duration_since(started_at), budget + 1)
                self.append(run_id, "cap.breached", {"kind": "run-duration", "limit": budget, "observed": observed})
                self.fail_run(
                    run_id, {"code": "run_timeout", "message": f"the run exceeded its {budget} ms deadline"}, started_at
                )
                return
            attempt = st.attempts.get(nid, 0)
            node_start = now_ms()
            self.append(run_id, "node.started", {"nodeId": nid, "typeId": node["typeId"], "attempt": attempt}, nid)
            try:
                result = self.execute_node(run, definition, node, st.resolved_count.get(nid, 0), deadline_ms)
            except HostClosing:
                raise
            except Exception as e:  # noqa: BLE001
                error = (
                    {"code": e.code, "message": e.message}
                    if isinstance(e, NodeFailure)
                    else {"code": "internal_error", "message": "the node failed unexpectedly"}
                )
                self.append(run_id, "node.failed", {"nodeId": nid, "error": error, "attempts": attempt + 1}, nid)
                self.fail_run(run_id, error, started_at, nid)
                return
            run = self.run(run_id)
            # An immediate pause was recorded by the request and cut this attempt: record nothing more.
            if run["status"] in TERMINAL or run["status"] == "paused":
                return
            if result == "cancelled":
                self.append(run_id, "node.cancelled", {"nodeId": nid, "reason": "run-cancelled"}, nid)
                self.cancel_now(run_id, run["cancel_reason"] or "caller-requested", started_at)
                return
            if result == "paused":
                return
            if result == "timeout":
                continue  # the deadline check above records the breach
            if "suspend" in result:
                replayed = (
                    self.recorded_resolution(run, result["suspend"]["key"]) if run["fork_mode"] == "replay" else None
                )
                if replayed is not None:
                    self.append(run_id, "interrupt.resolved", replayed, nid)
                    if self.apply_resolution(run_id, nid, replayed, started_at) == "failed":
                        return
                    continue
                self.suspend(run, node, result["suspend"])
                return
            self.append(
                run_id,
                "node.completed",
                {"nodeId": nid, "outputs": result["outputs"], "durationMs": now_ms() - node_start},
                nid,
            )
        run = self.run(run_id)
        if run["status"] in TERMINAL:
            return
        sources = {src for src, _ in edges_of(definition)}
        outputs: dict[str, Any] = {}
        for n in definition["nodes"]:
            if n["id"] not in sources:
                outputs.update(st.outputs.get(n["id"], {}))
        self.append(run_id, "run.completed", {"outputs": outputs, "durationMs": duration_since(started_at)})
        self.finish(run_id, "completed", None)

    def request_cancel(self, run: dict[str, Any], reason: str) -> str:
        """runs.md §Cancel — terminal now when nothing is executing; otherwise the run's thread finishes it."""
        if run["status"] in TERMINAL:
            raise err("run_terminal", f"a {run['status']} run cannot be cancelled", {"runStatus": run["status"]})
        if self.is_active(run["run_id"]):
            self.store.update_run(run["run_id"], status="cancelling", cancel_requested=1, cancel_reason=reason)
            return "cancelling"
        st = fold(self.events(run["run_id"]))
        if run["current_node_id"] is not None:
            self.append(
                run["run_id"],
                "node.cancelled",
                {"nodeId": run["current_node_id"], "reason": "run-cancelled"},
                run["current_node_id"],
            )
        self.cancel_now(run["run_id"], reason, st.started_at)
        return "cancelled"

    # ─── Interrupts ───────────────────────────────────────────────────────
    @staticmethod
    def principal_ref(subject: dict[str, Any]) -> str:
        return f"{subject['issuer']}#{subject['subjectId']}"

    def validate_resume(
        self, payload: dict[str, Any], resume_value: Any, subject: dict[str, Any] | None
    ) -> dict[str, Any]:
        kind = payload.get("kind")
        data = payload.get("data") or {}
        if kind == "approval":
            rv = resume_value if isinstance(resume_value, dict) else {}
            actions = data.get("actions") or ["accept", "reject"]
            action = rv.get("action")
            if not isinstance(action, str) or action == "timeout" or action not in actions:
                raise err(
                    "validation_error",
                    f"resumeValue.action MUST be one of the gate's actions [{', '.join(actions)}]",
                    {"field": "resumeValue.action"},
                )
            if action == "refine" and not isinstance(rv.get("refineFeedback"), dict):
                raise err("validation_error", "refine requires refineFeedback", {"field": "resumeValue.refineFeedback"})
            if action == "edit-accept" and "editedArtifactData" not in rv:
                raise err(
                    "validation_error",
                    "edit-accept requires editedArtifactData",
                    {"field": "resumeValue.editedArtifactData"},
                )
            approvers = data.get("approversList")
            if isinstance(approvers, list) and (subject is None or self.principal_ref(subject) not in approvers):
                raise err("forbidden", "the resolver is not in the gate's approversList")
            if action == "ask":
                return {"exits": False, "action": action}
            return {"exits": True, "action": action, "decision": "rejected" if action == "reject" else "granted"}
        if kind == "clarification" and isinstance(resume_value, dict) and isinstance(resume_value.get("answers"), list):
            ids = {str(q.get("id")) for q in data.get("questions") or [] if isinstance(q, dict)}
            for a in resume_value["answers"]:
                if not isinstance(a, dict) or str(a.get("id")) not in ids:
                    raise err(
                        "validation_error", "every answer id MUST be a question id", {"field": "resumeValue.answers"}
                    )
        required = (payload.get("resumeSchema") or {}).get("required")
        if isinstance(required, list):
            if not isinstance(resume_value, dict) or any(str(k) not in resume_value for k in required):
                raise err("validation_error", "resumeValue fails the interrupt's resumeSchema", {"required": required})
        return {"exits": True}

    def resolve(
        self, run: dict[str, Any], row: dict[str, Any], resume_value: Any, subject: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Both resolve surfaces converge here: validate, claim the interrupt atomically, record, resume."""
        run_id = run["run_id"]
        if run["status"] in TERMINAL:
            raise err("interrupt_already_resolved", f"the run is {run['status']}")
        payload = json.loads(row["payload_json"])
        v = self.validate_resume(payload, resume_value, subject)
        if not v["exits"]:
            return {"runId": run_id, "nodeId": row["node_id"], "status": run["status"]}
        if not self.store.claim_interrupt(row["interrupt_id"]):
            raise err("interrupt_already_resolved", "the interrupt is already resolved")
        resolved: dict[str, Any] = {
            "nodeId": row["node_id"],
            "interruptId": row["interrupt_id"],
            "kind": payload["kind"],
            "resumeValue": resume_value,
        }
        if subject is not None:
            resolved["resolvedBy"] = subject
        if "decision" in v:
            resolved["decision"] = v["decision"]
        if "action" in v:
            resolved["action"] = v["action"]
        rv = resume_value if isinstance(resume_value, dict) else {}
        if v.get("action") == "refine":
            resolved["refineFeedback"] = rv.get("refineFeedback")
        if v.get("action") == "edit-accept":
            resolved["editedArtifactData"] = rv.get("editedArtifactData")
        self.append(run_id, "interrupt.resolved", resolved, row["node_id"])
        started_at = fold(self.events(run_id)).started_at
        if self.apply_resolution(run_id, row["node_id"], resolved, started_at) == "failed":
            return {"runId": run_id, "nodeId": row["node_id"], "status": "failed"}
        self.store.update_run(run_id, status="running", current_node_id=None)
        self.schedule_run(run_id)
        return {"runId": run_id, "nodeId": row["node_id"], "status": "running"}

    def verify_token(self, token: str) -> dict[str, Any]:
        """identity.md §4 — `ow2.<alg>.<kid>.<payload>.<mac>`; one registered code per refusal."""
        parts = token.split(".")
        if len(parts) != 5 or parts[0] != "ow2":
            raise err("interrupt_token_invalid", "the token is outside the ow2.<alg>.<kid>.<payload>.<mac> grammar")
        _, alg, kid, payload, given = parts
        if alg != "hs256":
            raise err("interrupt_token_invalid", f"alg {alg} is not in interrupt.tokenAlgs")
        if kid != TOKEN_KID:
            raise err("interrupt_token_invalid", f"kid {kid} is not held by this host")
        expected = hmac.new(self.token_secret.encode(), f"hs256.{kid}.{payload}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, given):
            raise err("interrupt_token_invalid", "the token MAC does not verify")
        try:
            claims = json.loads(b64url_decode(payload))
        except ValueError:
            raise err("interrupt_token_invalid", "the token payload is unreadable") from None
        row = (
            self.store.interrupt_by_id(claims["i"])
            if isinstance(claims, dict) and isinstance(claims.get("i"), str)
            else None
        )
        if row is None:
            raise err("interrupt_token_invalid", "the token names no interrupt on this host")
        if isinstance(claims.get("e"), (int, float)) and now_ms() > claims["e"]:
            raise err("interrupt_expired", "the token is past its expiresAt")
        if row["state"] != "open":
            raise err("interrupt_already_resolved", "the interrupt is already resolved, or its run ended")
        return row
