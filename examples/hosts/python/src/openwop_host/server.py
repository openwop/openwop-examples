"""The front door: negotiation, identity, idempotency, discovery and the run routes.

Stdlib only: `http.server.ThreadingHTTPServer`, one thread per connection.
HTTP/1.1 with keep-alive; SSE responses use chunked transfer encoding.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import socket
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qsl, unquote, urlsplit

from . import __version__
from .contract import (
    ERA,
    ENGINE_VERSION,
    EXPERIMENTAL_UNTIL,
    IDEMPOTENCY_KEY,
    NODE_ID,
    NON_NEGATIVE_INT,
    POSITIVE_INT,
    PROTOCOL_VERSION,
    RUN_STATUSES,
    SINCE,
    TERMINAL,
    TERMINAL_EVENTS,
    VERSION_HEADER,
    WAITING,
    WORKFLOW_ID,
    HostError,
    b64url,
    b64url_decode,
    check_tenant_bound,
    err,
    now_iso,
    now_ms,
    project_bound_id,
    tenant_bound,
    unproject_bound_id,
)
from .executor import MAX_NODE_EXECUTIONS, Executor, options_of, payload_of
from .fixtures import load_workflows
from .store import Store

HOST_NAME = "openwop-host-python"
API_KEY_ISSUER = f"urn:{HOST_NAME}:api-key"
MAX_REQUEST_BODY_BYTES = 4_194_304
RUN_LIST_MAX_PAGE = 100
KEEP_ALIVE_SECONDS = 15.0


@dataclass
class HostOptions:
    host: str = "127.0.0.1"
    port: int = 3840
    db_path: str = "data/openwop-host-python.sqlite"
    api_key: str = "openwop-python-dev-key"
    tenant: str = "openwop-python-tenant"
    tenant_b_key: str | None = None
    tenant_b: str = "openwop-python-tenant-b"
    max_run_duration_ms: int = 600_000
    fixtures_dir: str | None = None
    log_resume_tokens: bool = False


@dataclass
class Reply:
    status: int
    body: Any = None
    headers: dict[str, str] = field(default_factory=dict)


STREAMED = object()


class Ctx:
    """One request, as the handlers see it."""

    def __init__(
        self,
        handler: "Handler",
        path: str,
        query: dict[str, str],
        params: dict[str, str],
        subject: dict[str, Any] | None,
    ) -> None:
        self.handler = handler
        self.path = path
        self.query = query
        self.params = params
        self.subject = subject

    def header(self, name: str) -> str | None:
        return self.handler.headers.get(name)

    @property
    def base_url(self) -> str:
        proto = self.header("x-forwarded-proto") or "http"
        host = self.header("host") or f"{self.handler.app.opts.host}:{self.handler.app.opts.port}"
        return f"{proto}://{host}"

    def raw_body(self) -> bytes:
        return self.handler.read_body()

    def body(self) -> dict[str, Any]:
        text = self.raw_body().decode("utf-8", errors="replace")
        if text.strip() == "":
            return {}
        try:
            parsed = json.loads(text)
        except ValueError:
            raise err("validation_error", "the request body is not JSON") from None
        if not isinstance(parsed, dict):
            raise err("validation_error", "the request body MUST be a JSON object")
        return parsed


Route = tuple[str, re.Pattern[str], bool, Callable[[Ctx], Any]]


def _dumps(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


class App:
    """Host state shared by every request thread."""

    def __init__(self, opts: HostOptions) -> None:
        self.opts = opts
        self.store = Store(opts.db_path)
        self.workflows = load_workflows(opts.fixtures_dir)
        self.executor = Executor(
            self.store,
            self.workflows,
            max_run_duration_ms=opts.max_run_duration_ms,
            log_resume_tokens=opts.log_resume_tokens,
            host_name=HOST_NAME,
        )
        self.cursor_secret = self.store.secret("run-list-cursor")
        self.closing = threading.Event()
        # ─── Identity ── one lane, `api-key`; each key is bound to one tenant and
        # resolves to one Subject (identity.md §1.1). The key realm is the issuer.
        self.keys: dict[str, dict[str, Any]] = {opts.api_key: self.subject_for(opts.tenant, "primary-key")}
        if opts.tenant_b_key:
            self.keys[opts.tenant_b_key] = self.subject_for(opts.tenant_b, "tenant-b-key")
        src = Path(__file__).resolve().parent
        digest = hashlib.sha256()
        for f in sorted(src.glob("*.py")):
            digest.update(f.read_bytes())
        self.host_build = {"kind": "artifact-sha256", "id": digest.hexdigest()}
        self.routes: list[Route] = []
        self._register_routes()

    @staticmethod
    def subject_for(tenant: str, subject_id: str) -> dict[str, Any]:
        return {"issuer": API_KEY_ISSUER, "subjectId": subject_id, "tenant": tenant, "lane": "api-key", "kind": "user"}

    def authenticate(self, header: str | None) -> dict[str, Any]:
        m = re.match(r"^Bearer\s+(.+)$", (header or "").strip(), re.IGNORECASE)
        if not m:
            raise err("unauthenticated", "a Bearer credential is required", None, {"WWW-Authenticate": "Bearer"})
        presented = m.group(1).strip().encode()
        for key, subject in self.keys.items():
            if hmac.compare_digest(key.encode(), presented):
                return subject
        raise err(
            "unauthenticated", "the credential is not valid", None, {"WWW-Authenticate": 'Bearer error="invalid_token"'}
        )

    def run_for(self, subject: dict[str, Any], id_: str) -> dict[str, Any]:
        """A tenant-bound run id for the caller. The bare (v1) form is 400: this host serves no 1.x member."""
        if "/" not in id_:
            raise err(
                "validation_error",
                "a bare run id is the v1 spelling; this host serves v2 only, so use <tenantId>/<id> (identity.md §5)",
                {"runId": id_},
            )
        check_tenant_bound(id_, subject["tenant"], "run")
        run = self.store.get_run(id_)
        if run is None or run["tenant"] != subject["tenant"]:
            raise err("not_found", "run not found")
        return run

    # ─── Projections ──────────────────────────────────────────────────────
    def event_doc(self, row: dict[str, Any]) -> dict[str, Any]:
        doc: dict[str, Any] = {
            "eventId": row["event_id"],
            "runId": row["run_id"],
            "type": row["type"],
            "payload": payload_of(row),
            "timestamp": row["timestamp"],
            "sequence": row["seq"],
            "schemaVersion": row["schema_version"],
        }
        if row["engine_version"] is not None:
            doc["engineVersion"] = row["engine_version"]
        if row["node_id"] is not None:
            doc["nodeId"] = row["node_id"]
        return doc

    def read_events(self, run_id: str, after: int = -1) -> list[dict[str, Any]]:
        return [self.event_doc(r) for r in self.store.events_after(run_id, after)]

    def snapshot(self, run: dict[str, Any]) -> dict[str, Any]:
        options = options_of(run)
        snap: dict[str, Any] = {
            "runId": run["run_id"],
            "workflowId": run["workflow_id"],
            "status": run["status"],
            "owner": json.loads(run["owner_json"]),
            "eventLogSchemaVersion": run["event_log_schema_version"],
            "inputs": json.loads(run["inputs_json"]),
            "engineVersion": run["engine_version"],
        }
        if run["status"] != "pending" and run["started_at"] is not None:
            snap["startedAt"] = run["started_at"]
        if run["ended_at"] is not None:
            snap["completedAt"] = run["ended_at"]
        if run["status"] in WAITING and run["current_node_id"] is not None:
            snap["currentNodeId"] = run["current_node_id"]
        if run["status"] == "failed" and run["error_json"] is not None:
            e = json.loads(run["error_json"])
            snap["error"] = {
                "code": str(e.get("code", "internal_error")),
                "message": str(e.get("message", "the run failed")),
            }
        for k in ("configurable", "tags", "metadata"):
            if k in options:
                snap[k] = options[k]
        if run["parent_run_id"] is not None:
            snap["parentRunId"] = run["parent_run_id"]
        return snap

    def links(self, ctx: Ctx, run_id: str) -> dict[str, str]:
        pid = project_bound_id(run_id)
        return {"eventsUrl": f"{ctx.base_url}/runs/{pid}/events", "statusUrl": f"{ctx.base_url}/runs/{pid}"}

    # ─── Discovery ────────────────────────────────────────────────────────
    #
    # capabilities.md — the closed v2 root: metadata keys plus one record per
    # family, `{ status, since, until?, witness, ...facets }`. A family is
    # advertised only when this host serves it end to end.

    @staticmethod
    def record(witness: str, **facets: Any) -> dict[str, Any]:
        return {"status": "experimental", "since": SINCE, "until": EXPERIMENTAL_UNTIL, "witness": witness, **facets}

    def discovery_document(self) -> dict[str, Any]:
        r = self.record
        return {
            "protocolVersions": [PROTOCOL_VERSION],
            "preferredVersion": PROTOCOL_VERSION,
            "implementation": {"name": HOST_NAME, "version": __version__, "vendor": "openwop (reference example)"},
            "engineVersion": ENGINE_VERSION,
            "eventLogSchemaVersion": ERA,
            "fixtures": sorted(self.workflows),
            "limits": {
                "status": "stable",
                "since": SINCE,
                "witness": "witnessable-gated",
                "clarificationRounds": 0,
                "maxNodeExecutions": MAX_NODE_EXECUTIONS,
                "maxRunDurationMs": self.opts.max_run_duration_ms,
                "maxRequestBodyBytes": MAX_REQUEST_BODY_BYTES,
            },
            "auth": r(
                "seam-gated",
                lanes=[
                    {
                        "lane": "api-key",
                        "issuers": [API_KEY_ISSUER],
                        "revocation": "next-request",
                        "minimumAssurance": "bearer",
                    }
                ],
            ),
            "eventLog": r("claims-check"),
            "idempotency": r("witnessable-gated", crossRegion="single-region"),
            "interrupt": r("witnessable-gated", tokenAlgs=["hs256"], refKinds=["principal"]),
            "replay": r("witnessable-gated", modes=["replay", "branch"], effectSeamsManifest="/host/effect-seams"),
            "runList": r("witnessable-gated", maxPageSize=RUN_LIST_MAX_PAGE, filters=["workflowId", "status"]),
        }

    # ─── Idempotency ──────────────────────────────────────────────────────
    def with_idempotency(self, ctx: Ctx, endpoint: str, fn: Callable[[], Reply]) -> Reply:
        """idempotency.md §Layer 1 — keyed (tenant, endpoint, key); a final outcome is
        replayed with `OpenWOP-Idempotent-Replay: true`; another digest under the key
        is 409 idempotency_key_mismatch; a concurrent duplicate is 409
        idempotency_in_flight; 400/401/403/429/5xx are never cached."""
        key = ctx.header("idempotency-key")
        if key is None or ctx.subject is None:
            return fn()
        if not IDEMPOTENCY_KEY.match(key):
            raise err("idempotency_key_invalid", "Idempotency-Key MUST match ^[A-Za-z0-9._~-]{22,128}$")
        tenant = ctx.subject["tenant"]
        digest = hashlib.sha256(ctx.path.encode() + b"\n" + ctx.raw_body()).hexdigest()
        s = self.store
        s.prune_idem(now_ms() - 24 * 3_600_000)
        existing = s.get_idem(tenant, endpoint, key)
        if existing is not None:
            if existing["digest"] != digest:
                raise err(
                    "idempotency_key_mismatch", "a different request was presented under the same Idempotency-Key"
                )
            if existing["status"] is None:
                raise err(
                    "idempotency_in_flight",
                    "a request under this Idempotency-Key is in flight",
                    None,
                    {"Retry-After": "1"},
                )
            headers = {**json.loads(existing["headers_json"] or "{}"), "OpenWOP-Idempotent-Replay": "true"}
            return Reply(
                existing["status"], None if existing["body"] is None else json.loads(existing["body"]), headers
            )
        if not s.claim_idem(tenant, endpoint, key, digest, now_ms()):
            raise err(
                "idempotency_in_flight",
                "a concurrent request under this Idempotency-Key is in flight",
                None,
                {"Retry-After": "1"},
            )

        def cacheable(status: int) -> bool:
            return status < 500 and status not in (400, 401, 403, 429)

        try:
            reply = fn()
        except HostError as e:
            if cacheable(e.status):
                s.complete_idem(tenant, endpoint, key, e.status, e.headers, e.body())
            else:
                s.release_idem(tenant, endpoint, key)
            raise
        except BaseException:
            s.release_idem(tenant, endpoint, key)
            raise
        if cacheable(reply.status):
            s.complete_idem(tenant, endpoint, key, reply.status, reply.headers, reply.body)
        else:
            s.release_idem(tenant, endpoint, key)
        return reply

    # ─── Routes ───────────────────────────────────────────────────────────
    def route(self, method: str, path: str, auth: bool) -> Callable[[Callable[[Ctx], Any]], Callable[[Ctx], Any]]:
        pattern = re.escape(path)
        pattern = re.sub(
            r"\\\{(\w+)\\\}",
            lambda m: f"(?P<{m.group(1)}>[^/:]+)" if m.group(1) == "runId" else f"(?P<{m.group(1)}>[^/]+)",
            pattern,
        )
        compiled = re.compile(f"^{pattern}$")

        def deco(fn: Callable[[Ctx], Any]) -> Callable[[Ctx], Any]:
            self.routes.append((method, compiled, auth, fn))
            return fn

        return deco

    def _register_routes(self) -> None:  # noqa: C901 — one place lists every operation
        route = self.route
        ex = self.executor
        store = self.store

        @route("GET", "/.well-known/openwop", False)
        def discovery(ctx: Ctx) -> Reply:
            text = _dumps(self.discovery_document())
            etag = '"' + hashlib.sha256(text).hexdigest()[:32] + '"'
            headers = {"ETag": etag, "Cache-Control": "public, max-age=60"}
            if if_none_match(ctx, etag):
                return Reply(304, None, headers)
            return Reply(200, json.loads(text), headers)

        # replay.md §The effect-seam manifest — this host's node runtime reaches no outbound effect path.
        @route("GET", "/host/effect-seams", True)
        def effect_seams(ctx: Ctx) -> Reply:
            return Reply(
                200, {"manifestVersion": "1", "host": {"name": HOST_NAME, "build": self.host_build}, "seams": []}
            )

        # ─── Runs ─────────────────────────────────────────────────────────
        @route("POST", "/runs", True)
        def create_run(ctx: Ctx) -> Reply:
            return self.with_idempotency(ctx, "createRun", lambda: self.create_run(ctx))

        @route("GET", "/runs", True)
        def list_runs(ctx: Ctx) -> Reply:
            return self.list_runs(ctx)

        @route("GET", "/runs/{runId}", True)
        def get_run(ctx: Ctx) -> Reply:
            run = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
            etag = f'"seq-{store.last_sequence(run["run_id"])}-{run["status"]}"'
            if if_none_match(ctx, etag):
                return Reply(304, None, {"ETag": etag})
            return Reply(200, self.snapshot(run), {"ETag": etag})

        @route("GET", "/runs/{runId}/events/poll", True)
        def poll(ctx: Ctx) -> Reply:
            return self.poll(ctx)

        @route("GET", "/runs/{runId}/events", True)
        def stream(ctx: Ctx) -> object:
            return self.stream(ctx)

        @route("POST", "/runs/{runId}/cancel", True)
        def cancel(ctx: Ctx) -> Reply:
            def go() -> Reply:
                run = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
                body = ctx.body()
                reason = body["reason"] if isinstance(body.get("reason"), str) else "caller-requested"
                return Reply(200, {"runId": run["run_id"], "status": ex.request_cancel(run, reason)})

            return self.with_idempotency(ctx, "cancelRun", go)

        @route("POST", "/runs:bulk-cancel", True)
        def bulk_cancel(ctx: Ctx) -> Reply:
            return self.with_idempotency(ctx, "bulkCancelRuns", lambda: self.bulk_cancel(ctx))

        @route("POST", "/runs/{runId}:pause", True)
        def pause(ctx: Ctx) -> Reply:
            return self.with_idempotency(ctx, "pauseRun", lambda: self.pause(ctx))

        @route("POST", "/runs/{runId}:resume", True)
        def resume(ctx: Ctx) -> Reply:
            def go() -> Reply:
                run = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
                body = ctx.body()
                if run["status"] in TERMINAL:
                    raise err("run_terminal", f"a {run['status']} run cannot be resumed", {"runStatus": run["status"]})
                if run["status"] != "paused":
                    raise err(
                        "run_state_conflict",
                        f"a run in status {run['status']} is not paused",
                        {"runStatus": run["status"]},
                    )
                store.append_event(
                    run["run_id"],
                    "run.resumed",
                    {"reason": body["reason"]} if isinstance(body.get("reason"), str) else {},
                )
                store.update_run(run["run_id"], status="running")
                ex.schedule_run(run["run_id"])
                return Reply(202, {"runId": run["run_id"], "status": "running", "resumedAt": now_iso()})

            return self.with_idempotency(ctx, "resumeRun", go)

        # idempotency.md §Witness — no node here performs an external effect, so the ledger is empty.
        @route("GET", "/runs/{runId}/effects", True)
        def effects(ctx: Ctx) -> Reply:
            run = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
            return Reply(200, {"runId": run["run_id"], "effects": []})

        @route("POST", "/runs/{runId}:fork", True)
        def fork(ctx: Ctx) -> Reply:
            return self.with_idempotency(ctx, "forkRun", lambda: self.fork(ctx))

        # ─── Interrupts ───────────────────────────────────────────────────
        @route("POST", "/runs/{runId}/interrupts/{nodeId}", True)
        def resolve_by_run(ctx: Ctx) -> Reply:
            def go() -> Reply:
                run = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
                node_id = ctx.params["nodeId"]
                if not NODE_ID.match(node_id):
                    raise err("not_found", "no such node")
                body = resume_body(ctx)
                row = store.open_interrupt(run["run_id"], node_id)
                if row is None:
                    if run["status"] in TERMINAL or store.any_interrupt(run["run_id"], node_id):
                        raise err("interrupt_already_resolved", "the interrupt is already resolved, or its run ended")
                    raise err("not_found", f"node {node_id} holds no interrupt")
                return Reply(200, ex.resolve(run, row, body["resumeValue"], ctx.subject))

            return self.with_idempotency(ctx, "resolveInterruptByRun", go)

        @route("GET", "/interrupts/{token}", False)
        def inspect_token(ctx: Ctx) -> Reply:
            row = ex.verify_token(ctx.params["token"])
            return Reply(200, json.loads(row["payload_json"]))

        @route("POST", "/interrupts/{token}", False)
        def resolve_by_token(ctx: Ctx) -> Reply:
            row = ex.verify_token(ctx.params["token"])
            run = store.get_run(row["run_id"])
            assert run is not None
            body = resume_body(ctx)
            return Reply(200, ex.resolve(run, row, body["resumeValue"], None))

    # ─── Run operations ───────────────────────────────────────────────────
    CREATE_KEYS = frozenset(
        {
            "workflowId",
            "inputs",
            "residency",
            "tenantId",
            "scopeId",
            "callbackUrl",
            "mode",
            "evalSuiteRef",
            "agentId",
            "runSecrets",
            "configurable",
            "tags",
            "metadata",
        }
    )
    CONFIGURABLE_SECTIONS = {
        "run": frozenset({"recursionLimit", "runTimeoutMs", "maxLoopIterations", "escalationThreshold"}),
        "ai": frozenset(
            {
                "provider",
                "model",
                "temperature",
                "maxTokens",
                "credentialRef",
                "promptOverrides",
                "mockProvider",
                "reasoningVerbosity",
                "maxRefusals",
            }
        ),
        "distillation": frozenset({"tokenBudget"}),
    }

    def validate_configurable(self, c: Any) -> None:
        """runs.md §Run options — `configurable` is closed, nested and versioned."""
        if not isinstance(c, dict):
            raise err("validation_error", "configurable MUST be an object", {"path": "configurable"})
        if c.get("version") != 1 or isinstance(c.get("version"), bool):
            raise err(
                "validation_error", "configurable.version is REQUIRED and MUST be 1", {"path": "configurable.version"}
            )
        for k, v in c.items():
            if k == "version":
                continue
            if k == "budget":
                raise err(
                    "capability_not_provided", "this host does not advertise budget", {"path": "configurable.budget"}
                )
            if k == "extensions":
                if not isinstance(v, dict):
                    raise err("validation_error", "configurable.extensions MUST be an object")
                continue
            section = self.CONFIGURABLE_SECTIONS.get(k)
            if section is None:
                raise err("validation_error", f"unknown configurable key {k}", {"path": f"configurable.{k}"})
            if not isinstance(v, dict):
                raise err("validation_error", f"configurable.{k} MUST be an object", {"path": f"configurable.{k}"})
            for inner in v:
                if inner not in section:
                    raise err(
                        "validation_error",
                        f"unknown key {inner} in configurable.{k}",
                        {"path": f"configurable.{k}.{inner}"},
                    )
            if k == "ai" and "provider" in v:
                raise err(
                    "validation_error",
                    "ai.provider MUST be in aiProviders.providers; this host advertises none",
                    {"path": "configurable.ai.provider"},
                )
            if k == "ai" and "temperature" in v:
                t = v["temperature"]
                if not isinstance(t, (int, float)) or isinstance(t, bool) or t < 0 or t > 2:
                    raise err("validation_error", "ai.temperature is 0..2", {"path": "configurable.ai.temperature"})
            if k == "run":
                for name, cap in (
                    ("recursionLimit", MAX_NODE_EXECUTIONS),
                    ("runTimeoutMs", self.opts.max_run_duration_ms),
                ):
                    x = v.get(name)
                    if x is not None and (not _is_int(x) or x < 1 or x > cap):
                        raise err(
                            "validation_error",
                            f"run.{name} is out of range (1..{cap})",
                            {"path": f"configurable.run.{name}"},
                        )

    def validate_options(self, body: dict[str, Any]) -> dict[str, Any]:
        if "configurable" in body:
            self.validate_configurable(body["configurable"])
        tags = body.get("tags")
        if "tags" in body and (
            not isinstance(tags, list) or len(tags) > 100 or not all(isinstance(t, str) and len(t) <= 256 for t in tags)
        ):
            raise err("validation_error", "tags: at most 100 strings of at most 256 characters", {"field": "tags"})
        if "metadata" in body and not isinstance(body["metadata"], dict):
            raise err("validation_error", "metadata MUST be an object", {"field": "metadata"})
        return {k: body[k] for k in ("configurable", "tags", "metadata") if k in body}

    def create_run(self, ctx: Ctx) -> Reply:
        body = ctx.body()
        subject = ctx.subject
        assert subject is not None
        for k in body:
            if k not in self.CREATE_KEYS:
                raise err("validation_error", f"unknown key {k}; the createRun body is closed", {"field": k})
        if body.get("mode") == "eval":
            raise err(
                "capability_not_provided",
                "mode: eval needs agents.evalSuite, which this host does not advertise",
                {"capability": "agents.evalSuite"},
            )
        if "mode" in body:
            raise err("validation_error", "mode MUST be eval when present", {"field": "mode"})
        workflow_id = body.get("workflowId")
        if not isinstance(workflow_id, str) or not WORKFLOW_ID.match(workflow_id):
            raise err("validation_error", "workflowId is REQUIRED", {"field": "workflowId"})
        if "tenantId" in body and body["tenantId"] != subject["tenant"]:
            raise err("forbidden", "tenantId MUST be the credential's tenant")
        if "callbackUrl" in body:
            raise err(
                "validation_error",
                "callbackUrl is refused: this host does not advertise interrupt.callbackDelivery",
                {"field": "callbackUrl"},
            )
        if "runSecrets" in body:
            raise err(
                "validation_error",
                "runSecrets is refused: this host does not advertise secrets.runSecrets",
                {"field": "runSecrets"},
            )
        if "inputs" in body and not isinstance(body["inputs"], dict):
            raise err("validation_error", "inputs MUST be an object", {"field": "inputs"})
        options = self.validate_options(body)
        definition = self.workflows.get(workflow_id)
        if definition is None:
            raise err(
                "not_found", f"workflow {workflow_id} is not registered on this host", {"workflowId": workflow_id}
            )
        scope_id = body["scopeId"] if isinstance(body.get("scopeId"), str) else None
        if (
            ctx.header("openwop-dedup") == "enforce"
            and scope_id is not None
            and self.store.active_for_scope(subject["tenant"], scope_id)
        ):
            raise err(
                "run_already_active",
                f"a run for scopeId {scope_id} is active",
                {"scopeId": scope_id},
                {"Retry-After": "5"},
            )
        variables = definition.get("variables") or []
        inputs = {v["name"]: v["defaultValue"] for v in variables if "defaultValue" in v}
        inputs.update(body.get("inputs") or {})
        for v in variables:
            if v.get("required") is True and inputs.get(v["name"]) is None:
                raise err(
                    "validation_error",
                    f"input {v['name']} is required by the workflow",
                    {"field": f"inputs.{v['name']}"},
                )
        run = self.store.insert_run(
            run_id=tenant_bound(subject["tenant"]),
            tenant=subject["tenant"],
            workflow_id=workflow_id,
            inputs=inputs,
            options=options,
            owner={"tenant": subject["tenant"], "subject": dict(subject)},
            scope_id=scope_id,
        )
        self.executor.schedule_run(run["run_id"])
        return Reply(201, {"runId": run["run_id"], "status": "pending", **self.links(ctx, run["run_id"])})

    def list_runs(self, ctx: Ctx) -> Reply:
        """RFC 0182 listRuns — newest first; the cursor is MAC'd so a cursor this host did not mint is refused."""
        tenant = ctx.subject["tenant"]  # type: ignore[index]
        q = ctx.query
        limit_raw = q.get("limit")
        if limit_raw is not None and not POSITIVE_INT.match(limit_raw):
            raise err("validation_error", "limit MUST be an integer >= 1", {"field": "limit"})
        limit = min(RUN_LIST_MAX_PAGE if limit_raw is None else int(limit_raw), RUN_LIST_MAX_PAGE)
        workflow_id = q.get("workflowId")
        if workflow_id is not None and not WORKFLOW_ID.match(workflow_id):
            raise err("validation_error", "workflowId does not match its grammar", {"field": "workflowId"})
        status = q.get("status")
        if status is not None and status not in RUN_STATUSES:
            raise err("validation_error", "status is not a run status", {"field": "status"})
        after = None
        cursor = q.get("cursor")
        if cursor is not None:
            try:
                created_at, run_id, mac = b64url_decode(cursor).decode("utf-8").split("|")
            except ValueError:
                raise err("validation_error", "the cursor is not one this host minted", {"field": "cursor"}) from None
            expect = self.cursor_mac(f"{created_at}|{run_id}")
            if not hmac.compare_digest(mac, expect):
                raise err("validation_error", "the cursor is not one this host minted", {"field": "cursor"})
            after = (created_at, run_id)
        rows = self.store.list_runs(tenant, limit=limit + 1, workflow_id=workflow_id, status=status, after=after)
        page = rows[:limit]
        body: dict[str, Any] = {"runs": [self.snapshot(r) for r in page]}
        if len(rows) > limit and page:
            last = page[-1]
            payload = f"{last['created_at']}|{last['run_id']}"
            body["nextCursor"] = b64url(f"{payload}|{self.cursor_mac(payload)}".encode())
        return Reply(200, body)

    def cursor_mac(self, payload: str) -> str:
        return b64url(hmac.new(self.cursor_secret.encode(), payload.encode(), hashlib.sha256).digest())

    def poll(self, ctx: Ctx) -> Reply:
        """events.md §Poll — `afterSequence` is an exclusive cursor; long-polls up to `timeout` seconds."""
        run = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
        raw_after = ctx.query.get("afterSequence")
        if raw_after is not None and not NON_NEGATIVE_INT.match(raw_after):
            raise err("validation_error", "afterSequence MUST be an integer >= 0", {"field": "afterSequence"})
        raw_timeout = ctx.query.get("timeout")
        timeout = 30 if raw_timeout is None else (int(raw_timeout) if POSITIVE_INT.match(raw_timeout) else -1)
        if timeout < 1 or timeout > 60:
            raise err("validation_error", "timeout is 1..60 seconds", {"field": "timeout"})
        after = -1 if raw_after is None else int(raw_after)
        until = now_ms() + timeout * 1000
        events = self.read_events(run["run_id"], after)
        fresh = self.store.get_run(run["run_id"]) or run
        while not events and fresh["status"] not in TERMINAL and now_ms() < until and not self.closing.is_set():
            self.store.wait_for_change(min(0.25, max(0.01, (until - now_ms()) / 1000)))
            events = self.read_events(run["run_id"], after)
            fresh = self.store.get_run(run["run_id"]) or run
        return Reply(
            200,
            {
                "runId": run["run_id"],
                "events": events,
                "lastSequence": self.store.last_sequence(run["run_id"]),
                "status": fresh["status"],
                "isTerminal": fresh["status"] in TERMINAL,
            },
        )

    def stream(self, ctx: Ctx) -> object:
        """events.md §SSE frames — `id:` is the sequence, `event:` the type (single mode)
        or the admitting mode (mixed), `data:` the RunEvent. Honours `streamMode`,
        `Last-Event-ID` (an exclusive cursor) and `bufferMs`; closes on the terminal."""
        run = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
        run_id = run["run_id"]
        modes = parse_stream_modes(ctx.query.get("streamMode"))
        last_raw = ctx.header("last-event-id")
        if last_raw is not None and not NON_NEGATIVE_INT.match(last_raw.strip()):
            raise err("validation_error", "Last-Event-ID MUST be a non-negative integer", {"header": "Last-Event-ID"})
        buffer_raw = ctx.query.get("bufferMs")
        buffer_ms = 0 if buffer_raw is None else (int(buffer_raw) if NON_NEGATIVE_INT.match(buffer_raw) else -1)
        if buffer_ms < 0 or buffer_ms > 5000:
            raise err("validation_error", "bufferMs is 0..5000", {"field": "bufferMs"})
        delivered = -1 if last_raw is None else int(last_raw.strip())
        values = "values" in modes
        out = ctx.handler.start_stream()
        batch: list[dict[str, Any]] = []

        def frame(id_: int, event: str, data: Any) -> None:
            out.write(f"id: {id_}\nevent: {event}\ndata: ".encode() + _dumps(data) + b"\n\n")

        def flush() -> None:
            nonlocal batch
            if batch:
                frame(batch[-1]["sequence"], "batch", batch)
                batch = []

        def emit(doc: dict[str, Any]) -> bool:
            """Deliver one event; True when the stream is finished."""
            nonlocal delivered
            delivered = doc["sequence"]
            mode = admitted_by(modes, doc["type"])
            if mode is not None:
                if buffer_ms > 0:
                    batch.append(doc)
                    if doc["type"] == "node.suspended" or doc["type"] in TERMINAL_EVENTS:
                        flush()
                else:
                    frame(doc["sequence"], doc["type"] if len(modes) == 1 else mode, doc)
                if values and mode == "values":
                    frame(doc["sequence"], "state.snapshot", self.snapshot(self.store.get_run(run_id) or run))
            return doc["type"] in TERMINAL_EVENTS

        try:
            if values and last_raw is not None:
                frame(delivered, "state.snapshot", self.snapshot(run))
            last_write = now_ms()
            tail = buffer_ms / 1000 if buffer_ms > 0 else 0.25
            while not self.closing.is_set():
                done = False
                for doc in self.read_events(run_id, delivered):
                    if emit(doc):
                        done = True
                        break
                if buffer_ms > 0:
                    flush()
                fresh = self.store.get_run(run_id)
                if (
                    done
                    or fresh is None
                    or fresh["status"] in TERMINAL
                    and not self.store.events_after(run_id, delivered)
                ):
                    flush()
                    break
                if now_ms() - last_write > KEEP_ALIVE_SECONDS * 1000:
                    out.write(b": keep-alive\n\n")
                    last_write = now_ms()
                self.store.wait_for_change(tail)
            out.close()
        except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError):
            ctx.handler.close_connection = True
        return STREAMED

    def bulk_cancel(self, ctx: Ctx) -> Reply:
        body = ctx.body()
        for k in body:
            if k not in ("runIds", "reason"):
                raise err("validation_error", f"unknown key {k}", {"field": k})
        ids = body.get("runIds")
        if not isinstance(ids, list) or not ids:
            raise err("validation_error", "runIds MUST be a non-empty array", {"field": "runIds", "maxRunIds": 100})
        if len(ids) > 100:
            raise err("validation_error", "runIds exceeds the host cap", {"maxRunIds": 100})
        reason = body["reason"] if isinstance(body.get("reason"), str) else "caller-requested"
        results = []
        for id_ in ids:
            try:
                if not isinstance(id_, str):
                    raise err("validation_error", "a runId MUST be a string")
                run = self.run_for(ctx.subject, unproject_bound_id(id_))  # type: ignore[arg-type]
                results.append({"runId": id_, "ok": True, "status": self.executor.request_cancel(run, reason)})
            except HostError as e:
                results.append({"runId": id_ if isinstance(id_, str) and id_ else "?", "ok": False, "error": e.body()})
        return Reply(200, {"results": results})

    def pause(self, ctx: Ctx) -> Reply:
        run = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
        run_id = run["run_id"]
        body = ctx.body()
        drain = body.get("drainPolicy", "drain-current-node")
        if drain not in ("immediate", "drain-current-node"):
            raise err("validation_error", "drainPolicy is immediate | drain-current-node", {"field": "drainPolicy"})
        if run["status"] in TERMINAL:
            raise err("run_terminal", f"a {run['status']} run cannot be paused", {"runStatus": run["status"]})
        if run["status"] not in ("running", "pending") or run["pause_requested"] is not None:
            pending = " (a pause is already pending)" if run["pause_requested"] is not None else ""
            raise err(
                "run_state_conflict",
                f"a run in status {run['status']} cannot be paused{pending}",
                {"runStatus": run["status"]},
            )
        reason = body["reason"] if isinstance(body.get("reason"), str) else "operator"
        executing = self.executor.is_active(run_id)
        if executing and drain == "drain-current-node":
            # The run's thread pauses it when the current node reaches its terminal.
            self.store.update_run(run_id, pause_requested=drain)
            return Reply(202, {"runId": run_id, "status": "paused"})
        # Nothing executing, or `immediate`: record the pause now. An executing
        # attempt is cut between events; the run's thread sees `paused` and stops.
        payload: dict[str, Any] = {"reason": reason, "drainPolicy": drain}
        if executing:
            open_: tuple[str, int] | None = None
            for e in self.read_events(run_id):
                n = e.get("nodeId")
                if e["type"] == "node.started" and n is not None:
                    open_ = (n, int(e["payload"].get("attempt", 0)) + 1)
                if (
                    e["type"] in ("node.completed", "node.failed", "node.suspended", "node.cancelled")
                    and open_
                    and n == open_[0]
                ):
                    open_ = None
            if open_ is not None:
                payload["interruptedNodeId"], payload["interruptedAttempt"] = open_
        self.store.append_event(run_id, "run.paused", payload)
        self.store.update_run(run_id, status="paused", pause_requested=None)
        return Reply(202, {"runId": run_id, "status": "paused", "pausedAt": now_iso()})

    def fork(self, ctx: Ctx) -> Reply:
        """replay.md — events `< fromSeq` are copied as fixed history; the child then
        re-executes. A replay keys its interrupts on its source and takes the
        source's recorded resolution; a branch is an independent run."""
        source = self.run_for(ctx.subject, ctx.params["runId"])  # type: ignore[arg-type]
        body = ctx.body()
        for k in body:
            if k not in ("mode", "fromSeq", "runOptionsOverlay"):
                raise err("validation_error", f"unknown key {k}", {"field": k})
        mode = body.get("mode")
        if mode not in ("replay", "branch"):
            raise err("validation_error", "mode is replay | branch", {"field": "mode"})
        if "fromSeq" not in body and mode == "branch":
            raise err("validation_error", "fromSeq is REQUIRED for branch", {"field": "fromSeq"})
        from_seq = body.get("fromSeq", 0)
        if not _is_int(from_seq) or from_seq < 0:
            raise err("validation_error", "fromSeq MUST be an integer >= 0", {"field": "fromSeq"})
        overlay = body.get("runOptionsOverlay")
        if "runOptionsOverlay" in body and not isinstance(overlay, dict):
            raise err("validation_error", "runOptionsOverlay MUST be an object", {"field": "runOptionsOverlay"})
        if mode == "replay" and overlay:
            raise err("validation_error", "runOptionsOverlay is branch-only", {"field": "runOptionsOverlay"})
        events = self.store.events_after(source["run_id"], -1)
        if from_seq > 0 and not any(e["seq"] == from_seq for e in events):
            raise err("fork_point_invalid", f"fromSeq {from_seq} is not in the source log", {"fromSeq": from_seq})
        terminal = next((e for e in events if e["type"] in TERMINAL_EVENTS), None)
        if terminal is not None and from_seq > terminal["seq"]:
            raise err(
                "fork_point_invalid", f"fromSeq {from_seq} is past the source's terminal event", {"fromSeq": from_seq}
            )
        options = {**options_of(source), **(self.validate_options(overlay) if overlay is not None else {})}
        child = self.store.insert_run(
            run_id=tenant_bound(source["tenant"]),
            tenant=source["tenant"],
            workflow_id=source["workflow_id"],
            inputs=json.loads(source["inputs_json"]),
            options=options,
            owner=json.loads(source["owner_json"]),
            parent_run_id=source["run_id"],
            fork_mode=mode,
            from_seq=from_seq,
        )
        self.store.copy_prefix(source["run_id"], child["run_id"], from_seq)
        self.executor.schedule_run(child["run_id"])
        return Reply(
            201,
            {
                "runId": child["run_id"],
                "sourceRunId": source["run_id"],
                "fromSeq": from_seq,
                "mode": mode,
                "status": "pending",
                "eventsUrl": self.links(ctx, child["run_id"])["eventsUrl"],
            },
        )

    def close(self) -> None:
        self.closing.set()
        self.store.notify()
        self.executor.close()
        self.store.close()


# ─── Helpers ─────────────────────────────────────────────────────────────────


def if_none_match(ctx: Ctx, etag: str) -> bool:
    """RFC 9110 §13.1.2 — `*` or any listed tag, under weak comparison."""
    h = ctx.header("if-none-match")
    if h is None:
        return False

    def strip(t: str) -> str:
        t = t.strip()
        return t[2:] if t.startswith("W/") else t

    return any(t.strip() == "*" or strip(t) == strip(etag) for t in h.split(","))


def resume_body(ctx: Ctx) -> dict[str, Any]:
    body = ctx.body()
    for k in body:
        if k != "resumeValue":
            raise err("validation_error", f"unknown key {k}; the body is {{ resumeValue }}", {"field": k})
    if "resumeValue" not in body:
        raise err("validation_error", "resumeValue is REQUIRED", {"field": "resumeValue"})
    return body


STREAM_MODE = re.compile(r"^(values|(updates|messages|debug)(,(updates|messages|debug))*)$")
DEBUG_ONLY = frozenset(
    {
        "log.appended",
        "variable.changed",
        "version.pinned",
        "lease.acquired",
        "lease.renewed",
        "lease.lost",
        "lease.handed-off",
        "node.retried",
    }
)


def parse_stream_modes(raw: str | None) -> list[str]:
    """events.md §Stream modes — the one grammar; this host serves all four modes."""
    value = "updates" if not raw else raw
    if not STREAM_MODE.match(value):
        raise err(
            "unsupported_stream_mode",
            f"streamMode {value} is outside the grammar",
            {"supported": ["updates", "values", "messages", "debug"]},
        )
    return value.split(",")


def admitted_by(modes: list[str], type_: str) -> str | None:
    """events.md §Stream modes — which mode admits an event, or None."""
    for mode in modes:
        if mode == "debug":
            return "debug"
        if mode in ("updates", "values") and type_ not in DEBUG_ONLY:
            return mode
        if mode == "messages" and type_ == "output.chunk":
            return "messages"
    return None


class ChunkedWriter:
    """HTTP/1.1 chunked transfer encoding, so a stream can end without closing the connection."""

    def __init__(self, wfile: Any) -> None:
        self.wfile = wfile

    def write(self, data: bytes) -> None:
        self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def close(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


# ─── The front door ──────────────────────────────────────────────────────────
#
# versioning.md §1.3: one major is served, 2. No header, `2` or `2.<n>` is
# served under it; any other major is 406; a malformed header is 400. Every
# protocol response carries `OpenWOP-Version: 2.0` (§1.4), refusals included.


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = HOST_NAME
    app: App  # set on the subclass `serve` builds

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 — stdlib signature
        pass

    def do_GET(self) -> None:
        self.dispatch()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = do_GET

    def read_body(self) -> bytes:
        if self._body is not None:
            return self._body
        if (self.headers.get("transfer-encoding") or "").lower() == "chunked":
            chunks = bytearray()
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                        pass
                    break
                chunks += self.rfile.read(size)
                self.rfile.readline()
                if len(chunks) > MAX_REQUEST_BODY_BYTES:
                    self.close_connection = True
                    raise err(
                        "validation_error",
                        "the request body exceeds limits.maxRequestBodyBytes",
                        {"maxRequestBodyBytes": MAX_REQUEST_BODY_BYTES},
                    )
            self._body = bytes(chunks)
            return self._body
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_REQUEST_BODY_BYTES:
            self.close_connection = True
            raise err(
                "validation_error",
                "the request body exceeds limits.maxRequestBodyBytes",
                {"maxRequestBodyBytes": MAX_REQUEST_BODY_BYTES},
            )
        self._body = self.rfile.read(length) if length > 0 else b""
        return self._body

    def start_stream(self) -> ChunkedWriter:
        self._streaming = True
        self.send_response(200)
        self.send_header("OpenWOP-Version", PROTOCOL_VERSION)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.wfile.flush()
        return ChunkedWriter(self.wfile)

    def send(self, reply: Reply) -> None:
        payload = b"" if reply.body is None else _dumps(reply.body)
        self.send_response(reply.status)
        self.send_header("OpenWOP-Version", PROTOCOL_VERSION)
        for k, v in reply.headers.items():
            self.send_header(k, v)
        if reply.body is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def dispatch(self) -> None:
        self._body: bytes | None = None
        self._streaming = False
        app = self.app
        split = urlsplit(self.path)
        path = split.path
        try:
            version = (self.headers.get("openwop-version") or "").strip()
            if version:
                m = VERSION_HEADER.match(version)
                if not m:
                    raise err(
                        "validation_error",
                        "OpenWOP-Version MUST be <major> or <major>.<minor>",
                        {"header": "OpenWOP-Version"},
                    )
                if m.group(1) != "2":
                    raise err(
                        "protocol_version_unsupported",
                        f"major {m.group(1)} is not served by this host",
                        {"protocolVersions": [PROTOCOL_VERSION]},
                    )
            method = self.command.upper()
            matched = None
            path_seen = False
            for r_method, pattern, auth, fn in app.routes:
                m = pattern.match(path)
                if not m:
                    continue
                path_seen = True
                if r_method != method:
                    continue
                matched = (auth, fn, m.groupdict())
                break
            if matched is None:
                raise err("not_found", f"{method} is not served at {path}" if path_seen else f"no operation at {path}")
            auth, fn, groups = matched
            params = {}
            for k, v in groups.items():
                decoded = unquote(v)
                params[k] = unproject_bound_id(decoded) if k == "runId" else decoded
            subject = app.authenticate(self.headers.get("authorization")) if auth else None
            query: dict[str, str] = {}
            for k, v in parse_qsl(split.query, keep_blank_values=True):
                query.setdefault(k, v)
            reply = fn(Ctx(self, path, query, params, subject))
            if reply is not STREAMED:
                self._drain()
                self.send(reply)
        except HostError as e:
            if self._streaming:
                self.close_connection = True
                return
            self._drain()
            self.send(Reply(e.status, e.body(), e.headers))
        except Exception as e:  # noqa: BLE001
            if self._streaming:
                self.close_connection = True
                return
            print(f"[{HOST_NAME}] unhandled error: {e!r}", flush=True)
            self.close_connection = True
            self.send(Reply(500, {"error": "internal_error", "message": "the host failed to serve the request"}))

    def _drain(self) -> None:
        """Read an unread body, so the next request on a kept-alive connection starts clean."""
        if self._body is None and not self.close_connection:
            try:
                self.read_body()
            except HostError:
                self.close_connection = True


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(opts: HostOptions) -> tuple[Server, App, threading.Thread, int]:
    app = App(opts)
    handler = type("BoundHandler", (Handler,), {"app": app})
    server = Server((opts.host, opts.port), handler)
    thread = threading.Thread(target=server.serve_forever, name="http", daemon=True)
    thread.start()
    resumed = app.executor.resume_unfinished()
    return server, app, thread, resumed
