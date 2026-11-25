"""The Python v2 host end to end, stdlib `unittest` only.

    python3 -m unittest discover -s tests -v      (from examples/hosts/python)

1. The contract: the `~` projection, and (when `OPENWOP_SPEC_ARTIFACTS_DIR`
   names an installed `@openwop/spec-artifacts`) every copied error row and
   event type against the corpus.
2. The core floor over HTTP, in-process: discovery, negotiation, create, poll,
   SSE with Last-Event-ID, idempotency, cancel, an approval resolved by run and
   by token, a replay fork that takes the recorded resolution.
3. Durable acceptance: a host process is SIGKILLed mid-run and the next process
   on the same file finishes the run, with one `run.started` and one terminal.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from openwop_host import contract  # noqa: E402
from openwop_host.server import HostOptions, serve  # noqa: E402

KEY = "openwop-python-dev-key"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def project(run_id: str) -> str:
    return contract.project_bound_id(run_id)


class Client:
    def __init__(self, base: str) -> None:
        self.base = base

    def call(
        self, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None
    ) -> tuple[int, Any, dict[str, str]]:
        h = {
            "OpenWOP-Version": "2",
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            **(headers or {}),
        }
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                text = res.read().decode()
                return res.status, json.loads(text) if text else None, dict(res.headers)
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            return e.code, json.loads(text) if text else None, dict(e.headers)

    def until(self, run_id: str, statuses: set[str], seconds: float = 15) -> dict[str, Any]:
        end = time.monotonic() + seconds
        while True:
            _, snap, _ = self.call("GET", f"/runs/{project(run_id)}")
            if snap["status"] in statuses:
                return snap
            if time.monotonic() > end:
                raise AssertionError(f"{run_id} stuck in {snap['status']}")
            time.sleep(0.05)

    def types(self, run_id: str) -> list[str]:
        _, body, _ = self.call("GET", f"/runs/{project(run_id)}/events/poll?timeout=1")
        return [e["type"] for e in body["events"]]


class ContractTest(unittest.TestCase):
    def test_projection_round_trips(self) -> None:
        for id_ in ("acme/r-9f3c0123456789abcdef", "t/ü-opaque-0123456789"):
            self.assertEqual(contract.unproject_bound_id(contract.project_bound_id(id_)), id_)
        self.assertEqual(contract.project_bound_id("acme/x"), "acme~2Fx")
        with self.assertRaises(contract.HostError):
            contract.unproject_bound_id("acme~2")

    def test_unregistered_code_is_a_bug(self) -> None:
        with self.assertRaises(RuntimeError):
            contract.err("not_a_code", "x")

    def test_rows_match_the_corpus(self) -> None:
        root = os.environ.get("OPENWOP_SPEC_ARTIFACTS_DIR")
        if not root:
            self.skipTest("OPENWOP_SPEC_ARTIFACTS_DIR is unset")
        rows = {r["code"]: r["httpStatus"] for r in json.loads(Path(root, "spec/v2/errors.json").read_text())["rows"]}
        for code, status in contract.ERRORS.items():
            self.assertEqual(rows.get(code), status, code)
        schema = json.loads(Path(root, "schemas/v2/run-event.schema.json").read_text())
        enum = {t for b in schema["properties"]["type"]["oneOf"] for t in b.get("enum", [])}
        self.assertEqual(contract.EVENT_TYPES - enum, set())


class FloorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server, cls.app, cls.thread, _ = serve(
            HostOptions(port=free_port(), db_path=":memory:", log_resume_tokens=False)
        )
        cls.c = Client(f"http://127.0.0.1:{cls.server.server_address[1]}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.app.close()
        cls.server.server_close()

    def create(self, workflow_id: str, **extra: Any) -> str:
        status, body, _ = self.c.call("POST", "/runs", {"workflowId": workflow_id, **extra})
        self.assertEqual(status, 201, body)
        return str(body["runId"])

    def test_discovery_and_negotiation(self) -> None:
        status, doc, headers = self.c.call("GET", "/.well-known/openwop")
        self.assertEqual(status, 200)
        self.assertEqual(doc["protocolVersions"], ["2.0"])
        self.assertEqual(headers["OpenWOP-Version"], "2.0")
        self.assertIn("conformance-noop", doc["fixtures"])
        status, _, _ = self.c.call("GET", "/.well-known/openwop", headers={"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        status, body, _ = self.c.call("GET", "/.well-known/openwop", headers={"OpenWOP-Version": "1"})
        self.assertEqual((status, body["error"]), (406, "protocol_version_unsupported"))

    def test_noop_completes_and_ids_are_tenant_bound(self) -> None:
        run_id = self.create("conformance-noop")
        self.assertTrue(run_id.startswith("openwop-python-tenant/"))
        self.assertEqual(self.c.until(run_id, {"completed"})["eventLogSchemaVersion"], 3)
        self.assertEqual(self.c.types(run_id), ["run.started", "node.started", "node.completed", "run.completed"])
        status, body, _ = self.c.call("GET", f"/runs/{run_id.split('/')[1]}")
        self.assertEqual((status, body["error"]), (400, "validation_error"))
        status, body, _ = self.c.call("GET", f"/runs/other-tenant~2F{run_id.split('/')[1]}")
        self.assertEqual((status, body["error"]), (403, "id_tenant_mismatch"))

    def test_sse_resumes_after_last_event_id(self) -> None:
        run_id = self.create("conformance-multi-node")
        self.c.until(run_id, {"completed"})
        req = urllib.request.Request(
            f"{self.c.base}/runs/{project(run_id)}/events",
            headers={"OpenWOP-Version": "2", "Authorization": f"Bearer {KEY}", "Last-Event-ID": "4"},
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            text = res.read().decode()
        ids = [int(line[4:]) for line in text.splitlines() if line.startswith("id: ")]
        self.assertEqual(ids, [5, 6, 7])

    def test_idempotency(self) -> None:
        key = {"Idempotency-Key": "python-host-test-key-0123456789"}
        body = {"workflowId": "conformance-idempotent", "inputs": {"nonce": "n1"}}
        s1, b1, _ = self.c.call("POST", "/runs", body, key)
        s2, b2, h2 = self.c.call("POST", "/runs", body, key)
        self.assertEqual((s1, s2, b1["runId"]), (201, 201, b2["runId"]))
        self.assertEqual(h2.get("OpenWOP-Idempotent-Replay"), "true")
        s3, b3, _ = self.c.call("POST", "/runs", {**body, "inputs": {"nonce": "n2"}}, key)
        self.assertEqual((s3, b3["error"]), (409, "idempotency_key_mismatch"))

    def test_cancel(self) -> None:
        run_id = self.create("conformance-cancellable")
        self.c.until(run_id, {"running"})
        status, body, _ = self.c.call("POST", f"/runs/{project(run_id)}/cancel", {})
        self.assertEqual(status, 200)
        self.assertIn(body["status"], {"cancelling", "cancelled"})
        self.c.until(run_id, {"cancelled"})
        self.assertEqual(self.c.types(run_id)[-2:], ["node.cancelled", "run.cancelled"])

    def test_approval_by_run_then_replay_fork(self) -> None:
        run_id = self.create("conformance-approval")
        self.c.until(run_id, {"waiting-approval"})
        status, body, _ = self.c.call(
            "POST", f"/runs/{project(run_id)}/interrupts/gate", {"resumeValue": {"action": "accept"}}
        )
        self.assertEqual(status, 200, body)
        self.c.until(run_id, {"completed"})
        status, fork, _ = self.c.call("POST", f"/runs/{project(run_id)}:fork", {"mode": "replay"})
        self.assertEqual(status, 201, fork)
        self.c.until(fork["runId"], {"completed"})
        # The replay takes the recorded resolution: no new interrupt is raised.
        self.assertNotIn("interrupt.requested", self.c.types(fork["runId"]))

    def test_fork_deadline_starts_at_the_fork(self) -> None:
        # runTimeoutMs 1500: the source completes, then ages past its deadline before the fork.
        run_id = self.create("conformance-approval", configurable={"version": 1, "run": {"runTimeoutMs": 1500}})
        self.c.until(run_id, {"waiting-approval"})
        self.c.call("POST", f"/runs/{project(run_id)}/interrupts/gate", {"resumeValue": {"action": "accept"}})
        self.c.until(run_id, {"completed"})
        time.sleep(2)
        # A branch re-executes from seq 1, so the deadline check runs (a replay of a completed run would not).
        status, fork, _ = self.c.call("POST", f"/runs/{project(run_id)}:fork", {"mode": "branch", "fromSeq": 1})
        self.assertEqual(status, 201, fork)
        snap = self.c.until(fork["runId"], {"waiting-approval", "failed"})
        self.assertEqual(snap["status"], "waiting-approval", self.c.types(fork["runId"]))

    def test_approval_by_token(self) -> None:
        run_id = self.create("conformance-approval")
        self.c.until(run_id, {"waiting-approval"})
        row = self.app.store.open_interrupt(run_id, "gate")
        token = self.app.executor.mint_token(row["interrupt_id"], run_id, row["expires_at"])
        status, payload, _ = self.c.call("GET", f"/interrupts/{token}")
        self.assertEqual((status, payload["kind"]), (200, "approval"))
        status, _, _ = self.c.call("POST", f"/interrupts/{token}", {"resumeValue": {"action": "reject"}})
        self.assertEqual(status, 200)
        self.c.until(run_id, {"failed"})
        status, body, _ = self.c.call("POST", f"/interrupts/{token}", {"resumeValue": {"action": "accept"}})
        self.assertEqual((status, body["error"]), (409, "interrupt_already_resolved"))


class DurabilityTest(unittest.TestCase):
    def start(self, db: str, port: int) -> subprocess.Popen[bytes]:
        env = {**os.environ, "PYTHONPATH": str(ROOT / "src"), "OPENWOP_PORT": str(port), "OPENWOP_SQLITE_PATH": db}
        proc = subprocess.Popen(
            [sys.executable, "-m", "openwop_host"],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        end = time.monotonic() + 10
        while time.monotonic() < end:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/.well-known/openwop", timeout=1).read()
                return proc
            except OSError:
                time.sleep(0.05)
        proc.kill()
        raise AssertionError("host did not start")

    def test_a_killed_run_resumes_on_the_next_boot(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db, port = str(Path(d) / "host.sqlite"), free_port()
            c = Client(f"http://127.0.0.1:{port}")
            first = self.start(db, port)
            try:
                status, body, _ = c.call(
                    "POST", "/runs", {"workflowId": "conformance-delay", "inputs": {"delayMs": 1500}}
                )
                self.assertEqual(status, 201)
                run_id = body["runId"]
                c.until(run_id, {"running"})
                time.sleep(0.2)
            finally:
                first.send_signal(signal.SIGKILL)
                first.wait()
            second = self.start(db, port)
            try:
                c.until(run_id, {"completed"})
                types = c.types(run_id)
                self.assertEqual(types.count("run.started"), 1)
                self.assertEqual(types.count("run.completed"), 1)
                # The attempt the crash cut shows as a second node.started.
                self.assertEqual(types.count("node.started"), 2)
            finally:
                second.terminate()
                second.wait()


if __name__ == "__main__":
    unittest.main()
