"""The contract: constants, the error registry, id grammars and the `~` projection.

Everything here is a pure function of the v2 corpus (`spec/v2/errors.json`,
`schemas/v2/ids.schema.json`, `schemas/v2/run-event.schema.json`,
`spec/v2/core/identity.md` §5). The rows are copied, not loaded: the host has no
dependency on the npm `@openwop/spec-artifacts` package, and
`tests/test_contract.py` checks every copied row against that package when it is
installed beside the host.
"""

from __future__ import annotations

import base64
import re
import secrets
from datetime import datetime, timezone
from typing import Any

PROTOCOL_VERSION = "2.0"
ENGINE_VERSION = 1
#: persistence.md §The era key — a v2 host stamps 3 on every run it creates.
ERA = 3
EVENT_SCHEMA_VERSION = 1
SINCE = "2.0"
EXPERIMENTAL_UNTIL = "2.1"

TERMINAL = frozenset({"completed", "failed", "cancelled"})
WAITING = frozenset({"waiting-approval", "waiting-input", "waiting-external"})
RUN_STATUSES = frozenset(
    {
        "pending",
        "running",
        "paused",
        "waiting-approval",
        "waiting-input",
        "waiting-external",
        "completed",
        "failed",
        "cancelling",
        "cancelled",
    }
)

# ─── Errors ──────────────────────────────────────────────────────────────────
#
# errors.md — every error a v2 host returns is a row in spec/v2/errors.json.
# The registry decides the HTTP status; the body is the flat closed envelope
# `{ error, message, details? }`; retry timing travels in `Retry-After` only.
# These are the rows this host can emit (code -> httpStatus).

ERRORS: dict[str, int] = {
    "approval_rejected": 422,
    "capability_not_provided": 422,
    "forbidden": 403,
    "fork_point_invalid": 422,
    "id_tenant_mismatch": 403,
    "idempotency_in_flight": 409,
    "idempotency_key_invalid": 400,
    "idempotency_key_mismatch": 409,
    "internal_error": 500,
    "interrupt_already_resolved": 409,
    "interrupt_expired": 410,
    "interrupt_token_invalid": 401,
    "not_found": 404,
    "protocol_version_unsupported": 406,
    "recursion_limit_exceeded": 422,
    "run_already_active": 409,
    "run_state_conflict": 409,
    "run_terminal": 409,
    "run_timeout": 422,
    "unauthenticated": 401,
    "unsupported_stream_mode": 400,
    "validation_error": 400,
}


class HostError(Exception):
    """A registered refusal. Constructing an unregistered code is a host bug."""

    def __init__(
        self, code: str, message: str, details: dict[str, Any] | None = None, headers: dict[str, str] | None = None
    ) -> None:
        if code not in ERRORS:
            # A producer MUST NOT emit an unregistered member (overview.md §0).
            raise RuntimeError(f"unregistered error code emitted by the host: {code}")
        super().__init__(message)
        self.code = code
        self.status = ERRORS[code]
        self.message = message
        self.details = details
        self.headers = headers or {}

    def body(self) -> dict[str, Any]:
        out: dict[str, Any] = {"error": self.code, "message": self.message}
        if self.details is not None:
            out["details"] = self.details
        return out


def err(
    code: str, message: str, details: dict[str, Any] | None = None, headers: dict[str, str] | None = None
) -> HostError:
    return HostError(code, message, details, headers)


# ─── Event types ─────────────────────────────────────────────────────────────
#
# The v2 RunEvent types this host emits; each is in the closed enum of
# schemas/v2/run-event.schema.json. `append_event` refuses any other name.

EVENT_TYPES = frozenset(
    {
        "run.started",
        "run.completed",
        "run.failed",
        "run.cancelled",
        "run.paused",
        "run.resumed",
        "node.started",
        "node.completed",
        "node.failed",
        "node.cancelled",
        "node.suspended",
        "node.resumed",
        "interrupt.requested",
        "interrupt.resolved",
        "cap.breached",
    }
)
TERMINAL_EVENTS = frozenset({"run.completed", "run.failed", "run.cancelled"})

# ─── Ids ─────────────────────────────────────────────────────────────────────
#
# identity.md §5 — host-minted opaque segments are `^[A-Za-z0-9._~-]{16,128}$`;
# tenant-bound kinds are `<tenantId>/<opaque>`.

OPAQUE = re.compile(r"^[A-Za-z0-9._~-]{16,128}$")
TENANT_ID = re.compile(r"^[A-Za-z0-9._~-]{1,128}$")
NODE_ID = re.compile(r"^[A-Za-z0-9._~:-]{1,128}$")
WORKFLOW_ID = NODE_ID
IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._~-]{22,128}$")
NON_NEGATIVE_INT = re.compile(r"^(0|[1-9][0-9]*)$")
POSITIVE_INT = re.compile(r"^[1-9][0-9]*$")
VERSION_HEADER = re.compile(r"^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def opaque() -> str:
    """24 base64url characters (144 bits): inside the opaque grammar, no `/`."""
    return b64url(secrets.token_bytes(18))


def tenant_bound(tenant: str) -> str:
    return f"{tenant}/{opaque()}"


_PASSTHROUGH = re.compile(r"^[A-Za-z0-9._-]$")
_HEX2 = re.compile(r"^[0-9A-Fa-f]{2}$")


def project_bound_id(id_: str) -> str:
    """identity.md §5 / RFC 0184 — a tenant-bound id travels as ONE path segment:
    every UTF-8 byte outside `[A-Za-z0-9._-]` becomes `~` + two uppercase hex
    digits (`acme/r-9f3c` -> `acme~2Fr-9f3c`). Not idempotent: project once."""
    out = []
    for byte in id_.encode("utf-8"):
        ch = chr(byte)
        out.append(ch if byte < 0x80 and _PASSTHROUGH.match(ch) else f"~{byte:02X}")
    return "".join(out)


def unproject_bound_id(segment: str) -> str:
    """The accept side. A `~` not introducing two hex digits is 400, not 404."""
    if "~" not in segment:
        return segment
    raw = bytearray()
    i = 0
    while i < len(segment):
        if segment[i] == "~":
            pair = segment[i + 1 : i + 3]
            if not _HEX2.match(pair):
                raise err(
                    "validation_error",
                    f"bound-id projection: '~' at index {i} is not followed by two hex digits (identity.md §5)",
                    {"segment": segment},
                )
            raw.append(int(pair, 16))
            i += 3
        else:
            raw.extend(segment[i].encode("utf-8"))
            i += 1
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise err(
            "validation_error",
            "bound-id projection: the escaped bytes are not valid UTF-8 (identity.md §5)",
            {"segment": segment},
        ) from None


def check_tenant_bound(id_: str, tenant: str, kind: str) -> str:
    """Split a tenant-bound id; 403 id_tenant_mismatch when the segment is not the caller's."""
    tenant_seg, sep, tail = id_.partition("/")
    if not sep or not tenant_seg:
        raise err("not_found", f"{kind} {id_} is not a tenant-bound id")
    if not TENANT_ID.match(tenant_seg) or not OPAQUE.match(tail):
        raise err("not_found", f"{kind} not found")
    if tenant_seg != tenant:
        raise err("id_tenant_mismatch", f"the {kind}'s tenant segment is not the caller's")
    return tail


# ─── Time ────────────────────────────────────────────────────────────────────


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_to_ms(text: str) -> int:
    return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)
