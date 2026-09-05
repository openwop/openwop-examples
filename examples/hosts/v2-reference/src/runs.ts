/**
 * runs.md — the run surface of api/v2/openapi.yaml plus the v1 keys the host
 * keeps through the overlap (versioning.md §1.2). Handlers only; the loop is
 * executor.ts, the fork is replay.ts, the projections are effects.ts.
 */
import { EVENT_LOG_SCHEMA_VERSION, ENGINE_VERSION, HOST_ID } from './config.js';
import { compensationProjection, compensationStatusOf, effectsProjection, effectSeamManifest } from './effects.js';
import { err } from './errors.js';
import { applyPinDisposition, requestCancel, requestPause, requestResume, resolveAndResume, scheduleRun } from './executor.js';
import { ownerOf, parseStreamModes, pollResponse, readEvents, streamRun } from './events.js';
import { checkTenantBound, nowIso, NODE_ID, tenantBound, VERSION, WORKFLOW_ID } from './ids.js';
import { mintToken, payloadOf, verifyToken } from './interrupts.js';
import { forkRun } from './replay.js';
import { route, STREAMED, withIdempotency, type Ctx, type Reply, type Route } from './router.js';
import { TERMINAL, type Host } from './host.js';
import type { RunRow } from './store.js';
import { principalRef } from './identity.js';

const CREATE_KEYS = new Set(['workflowId', 'inputs', 'residency', 'tenantId', 'scopeId', 'callbackUrl', 'mode', 'evalSuiteRef', 'agentId', 'configurable', 'tags', 'metadata']);
const CONFIGURABLE_SECTIONS: Record<string, Set<string>> = {
  run: new Set(['recursionLimit', 'runTimeoutMs', 'maxLoopIterations', 'escalationThreshold']),
  ai: new Set(['provider', 'model', 'temperature', 'maxTokens', 'credentialRef', 'promptOverrides', 'mockProvider', 'reasoningVerbosity', 'maxRefusals']),
  distillation: new Set(['tokenBudget']),
};

/** runs.md §Run options — closed, nested, versioned; a dotted or unknown key is 400 validation_error. */
export function validateConfigurable(c: unknown): void {
  if (c === undefined) return;
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw err('validation_error', 'configurable MUST be an object');
  const obj = c as Record<string, unknown>;
  if (obj['version'] !== 1) throw err('validation_error', 'configurable.version is REQUIRED and MUST be 1', { path: 'configurable.version' });
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'version') continue;
    if (k === 'budget') { if (v === null || typeof v !== 'object') throw err('validation_error', 'configurable.budget MUST be an object'); continue; }
    if (k === 'extensions') {
      if (v === null || typeof v !== 'object') throw err('validation_error', 'configurable.extensions MUST be an object');
      for (const org of Object.keys(v as object)) if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(org)) throw err('validation_error', `configurable.extensions.${org} is not an org key`, { path: `configurable.extensions.${org}` });
      continue;
    }
    const section = CONFIGURABLE_SECTIONS[k];
    if (section === undefined) throw err('validation_error', `unknown configurable key ${k} (closed schema)`, { path: `configurable.${k}` });
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw err('validation_error', `configurable.${k} MUST be an object`);
    for (const inner of Object.keys(v as object)) {
      if (!section.has(inner)) throw err('validation_error', `unknown key ${inner} in configurable.${k}${inner.includes('.') ? ' (a dotted key is not a section path)' : ''}`, { path: `configurable.${k}.${inner}` });
    }
    const ai = v as Record<string, unknown>;
    if (k === 'ai' && ai['temperature'] !== undefined && (typeof ai['temperature'] !== 'number' || ai['temperature'] < 0 || ai['temperature'] > 2)) throw err('validation_error', 'ai.temperature is 0..2');
    if (k === 'ai' && ai['provider'] !== undefined) throw err('validation_error', 'ai.provider MUST be in aiProviders.providers — this host advertises no AI provider', { path: 'configurable.ai.provider' });
    if (k === 'ai' && ai['mockProvider'] !== undefined) throw err('mock_provider_forbidden', 'mockProvider is test-keys-only and this host advertises no mock provider');
    if (k === 'run' && ai['runTimeoutMs'] !== undefined && (!Number.isInteger(ai['runTimeoutMs']) || (ai['runTimeoutMs'] as number) < 1 || (ai['runTimeoutMs'] as number) > 600_000)) throw err('validation_error', 'run.runTimeoutMs is out of range (1..limits.maxRunDurationMs)');
  }
}

export function snapshot(host: Host, run: RunRow): Record<string, unknown> {
  const options = JSON.parse(run.options_json) as { configurable?: unknown; tags?: unknown; metadata?: unknown };
  const snap: Record<string, unknown> = {
    runId: run.run_id,
    workflowId: run.workflow_id,
    status: run.status,
    owner: ownerOf(host, run),
    eventLogSchemaVersion: run.era ?? 2,
    engineVersion: ENGINE_VERSION,
    compensationStatus: compensationStatusOf(run),
    variables: JSON.parse(run.inputs_json),
  };
  if (run.current_node_id !== null) snap['currentNodeId'] = run.current_node_id;
  if (run.started_at !== null) snap['startedAt'] = run.started_at;
  if (run.completed_at !== null) snap['completedAt'] = run.completed_at;
  if (run.error_json !== null) snap['error'] = JSON.parse(run.error_json);
  if (options.configurable !== undefined) snap['configurable'] = options.configurable;
  if (options.tags !== undefined) snap['tags'] = options.tags;
  if (options.metadata !== undefined) snap['metadata'] = options.metadata;
  host.validate('run-snapshot', snap, `snapshot ${run.run_id}`);
  return snap;
}

/** Resolve a run the caller may see; 403 id_tenant_mismatch never discloses existence. */
/**
 * errors.md (rc.40): a malformed JSON body is refused 400 validation_error by
 * the host's own negotiation layer — never a framework 500. The router's
 * `ctx.json()` already does this; the create and fork handlers read the raw
 * text (the idempotency digest is over the bytes) and parse it here.
 */
function parseJsonBody(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw err('validation_error', 'the request body is not JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw err('validation_error', 'the request body MUST be a JSON object');
  return parsed as Record<string, unknown>;
}

/**
 * versioning.md §5 (rc.44): a run is ONE row named by its tenant-bound id
 * `<tenantId>/<opaque>`; the v1 surface names the same run by the bare opaque
 * id (v1 ids carry no tenant segment), and major 2 names it by the projection
 * `<tenantId>/<the v1 id>` — so a bare id on a /v1/ path resolves under the
 * caller's tenant, and a v1 reply strips the segment it never had.
 */
function wireRunId(ctx: Ctx, runId: string): string {
  if (ctx.major !== 1) return runId;
  const slash = runId.indexOf('/');
  return slash > 0 ? runId.slice(slash + 1) : runId;
}

export function loadRun(ctx: Ctx, runId: string): RunRow {
  const tenant = ctx.subject?.tenant ?? ctx.host.config.tenant;
  // A bare id (no tenant segment) is the v1 spelling of a run this tenant owns:
  // on a /v1/ path it is the only spelling, and under major 2 it is how a
  // client that holds a v1-minted id reaches the same run through the overlap
  // (versioning.md §5) — resolved under the CALLER's tenant, never another's,
  // so identity.md §5's 403 check has nothing to read and nothing to protect.
  const id = runId.includes('/') ? runId : `${tenant}/${runId}`;
  checkTenantBound(id, tenant, 'runId');
  const run = ctx.host.store.getRun(id);
  if (!run || run.tenant !== tenant) throw err('not_found', 'run not found');
  return applyPinDisposition(ctx.host, run);
}

async function createRun(ctx: Ctx): Promise<Reply> {
  const text = await ctx.text();
  return withIdempotency(ctx, 'createRun', text, async () => {
    const body = parseJsonBody(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw err('validation_error', 'the create body MUST be an object');
    for (const k of Object.keys(body)) if (!CREATE_KEYS.has(k)) throw err('validation_error', `unknown key ${k} — the createRun body is closed`, { key: k });
    const subject = ctx.subject;
    if (subject === null) throw err('unauthenticated', 'runs:create needs a credential');
    if (body['mode'] === 'eval') throw err('capability_required', 'mode: eval needs agents.evalSuite, which this host does not advertise', { capability: 'agents.evalSuite' });
    if (body['mode'] !== undefined) throw err('validation_error', 'mode MUST be eval when present');
    const workflowId = body['workflowId'];
    if (typeof workflowId !== 'string' || !WORKFLOW_ID.test(workflowId)) throw err('validation_error', 'workflowId is REQUIRED (ids.schema.json workflowId grammar)');
    if (body['tenantId'] !== undefined && body['tenantId'] !== subject.tenant) throw err('forbidden', 'tenantId MUST be the credential\'s tenant; the tenant never comes from the body');
    if (body['residency'] !== undefined) {
      const region = (body['residency'] as { region?: unknown } | null)?.region;
      throw err('residency_unavailable', `residency.region ${String(region)} is not advertised by this host (dataResidency not advertised)`, { region });
    }
    if (body['inputs'] !== undefined && (body['inputs'] === null || typeof body['inputs'] !== 'object' || Array.isArray(body['inputs']))) throw err('validation_error', 'inputs MUST be an object');
    validateConfigurable(body['configurable']);
    const tags = body['tags'];
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.length > 100 || !tags.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 256)) throw err('validation_error', 'tags: at most 100 strings of at most 256 characters', { maxItems: 100, maxLength: 256 });
    }
    if (body['metadata'] !== undefined && (body['metadata'] === null || typeof body['metadata'] !== 'object' || Array.isArray(body['metadata']))) throw err('validation_error', 'metadata MUST be an object');
    if (body['callbackUrl'] !== undefined && typeof body['callbackUrl'] !== 'string') throw err('validation_error', 'callbackUrl MUST be a URI');
    if (ctx.header('openwop-force-engine-version') !== null) throw err('force_engine_version_forbidden', 'OpenWOP-Force-Engine-Version is test-keys-only; this host advertises no forceEngineVersionRange');
    const def = ctx.host.workflows.get(workflowId);
    if (!def) throw err('not_found', `workflow ${workflowId} is not registered on this host`, { workflowId });
    // A workflow naming a node type this host does not execute is refused at create (runs.md §Create).
    const scopeId = typeof body['scopeId'] === 'string' ? body['scopeId'] : null;
    if (ctx.header('openwop-dedup') === 'enforce' && scopeId !== null) {
      const activeRun = ctx.host.store.activeRunForScope(subject.tenant, scopeId);
      if (activeRun) throw err('run_already_active', `a run for scopeId ${scopeId} is active`, { runId: activeRun.run_id, scopeId }, { 'Retry-After': '5' });
    }
    const options: Record<string, unknown> = {};
    if (body['configurable'] !== undefined) options['configurable'] = body['configurable'];
    if (tags !== undefined) options['tags'] = tags;
    if (body['metadata'] !== undefined) options['metadata'] = body['metadata'];
    const inputs = { ...Object.fromEntries(def.variables.filter((v) => v.defaultValue !== undefined).map((v) => [v.name, v.defaultValue])), ...((body['inputs'] as Record<string, unknown> | undefined) ?? {}) };
    for (const v of def.variables) if (v.required === true && inputs[v.name] === undefined) throw err('validation_error', `input ${v.name} is required by the workflow`, { variable: v.name });
    const run: RunRow = {
      run_id: tenantBound(subject.tenant), tenant: subject.tenant, workflow_id: workflowId, status: 'pending', era: EVENT_LOG_SCHEMA_VERSION,
      owner_json: JSON.stringify({ tenant: subject.tenant, subject }), options_json: JSON.stringify(options), inputs_json: JSON.stringify(inputs),
      created_at: nowIso(), updated_at: nowIso(), started_at: null, completed_at: null, current_node_id: null, error_json: null,
      source_run_id: null, fork_mode: null, from_seq: null, compensation_json: null, pause_requested: 0, cancel_requested: 0, pin_checked: 1, scope_id: scopeId,
    };
    ctx.host.store.insertRun(run);
    scheduleRun(ctx.host, run.run_id);
    const prefix = ctx.major === 1 ? '/v1' : '';
    const wire = wireRunId(ctx, run.run_id);
    const id = encodeURIComponent(wire);
    return { status: 201, body: { runId: wire, status: 'pending', eventsUrl: `${ctx.baseUrl}${prefix}/runs/${id}/events`, statusUrl: `${ctx.baseUrl}${prefix}/runs/${id}` } };
  });
}

async function getRun(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const body = { ...snapshot(ctx.host, run), runId: wireRunId(ctx, run.run_id) };
  const etag = `"seq-${ctx.host.store.lastSequence(run.run_id)}-${run.status}"`;
  if (ctx.header('if-none-match') === etag) return { status: 304, headers: { ETag: etag } };
  return { status: 200, body, headers: { ETag: etag } };
}

async function poll(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const raw = ctx.url.searchParams.get('afterSequence') ?? ctx.url.searchParams.get('since');
  let after: number | undefined;
  if (raw !== null) {
    if (!/^\d+$/.test(raw)) throw err('validation_error', 'afterSequence MUST be an integer >= 0');
    after = Number(raw);
  }
  const timeoutRaw = ctx.url.searchParams.get('timeout');
  const timeout = timeoutRaw === null ? 30 : Number(timeoutRaw);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60) throw err('validation_error', 'timeout is 1..60 seconds');
  let body = pollResponse(ctx.host, run, after);
  if (body.events.length === 0 && !body.isTerminal) {
    // long-poll: wait for the next append or the timeout
    await new Promise<void>((resolve) => {
      const done = (): void => { ctx.host.bus.off(`run:${run.run_id}`, done); clearTimeout(t); resolve(); };
      const t = setTimeout(done, Math.min(timeout, 60) * 1000);
      ctx.host.bus.on(`run:${run.run_id}`, done);
    });
    body = pollResponse(ctx.host, run, after);
  }
  return { status: 200, body };
}

async function stream(ctx: Ctx): Promise<Reply | typeof STREAMED> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const modes = parseStreamModes(ctx.url.searchParams.get('streamMode'));
  const lastIdRaw = ctx.header('last-event-id');
  const lastEventId = lastIdRaw !== null && /^\d+$/.test(lastIdRaw) ? Number(lastIdRaw) : null;
  const bufferRaw = ctx.url.searchParams.get('bufferMs');
  const bufferMs = bufferRaw === null ? 0 : Number(bufferRaw);
  if (!Number.isFinite(bufferMs) || bufferMs < 0 || bufferMs > 5000) throw err('validation_error', 'bufferMs is 0..5000');
  streamRun(ctx.host, run, ctx.res, { modes, lastEventId, bufferMs, snapshot: () => snapshot(ctx.host, ctx.host.store.getRun(run.run_id) ?? run), headers: ctx.responseHeaders });
  return STREAMED;
}

async function cancel(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const body = await ctx.json<{ reason?: unknown }>();
  return withIdempotency(ctx, 'cancelRun', JSON.stringify(body), async () => {
    const r = requestCancel(ctx.host, run, typeof body.reason === 'string' ? body.reason : undefined);
    return { status: 200, body: { runId: wireRunId(ctx, run.run_id), status: r.status } };
  });
}

async function bulkCancel(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ runIds?: unknown; reason?: unknown }>();
  const ids = body.runIds;
  if (!Array.isArray(ids) || ids.length === 0) throw err('validation_error', 'runIds[1..100] is REQUIRED');
  if (ids.length > 100) throw err('validation_error', 'at most 100 runIds per request', { maxRunIds: 100 });
  const results = ids.map((id) => {
    try {
      const run = loadRun(ctx, String(id));
      const r = requestCancel(ctx.host, run, typeof body.reason === 'string' ? body.reason : undefined);
      return { runId: String(id), ok: true, status: r.status };
    } catch (e) {
      const he = e as { code?: string; message: string; body?: () => unknown };
      return { runId: String(id), ok: false, error: typeof he.body === 'function' ? he.body() : { error: 'run_forbidden', message: he.message } };
    }
  });
  return { status: 200, body: { results } };
}

async function pause(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const body = await ctx.json<{ reason?: unknown; drainPolicy?: unknown }>();
  for (const k of Object.keys(body)) if (k !== 'reason' && k !== 'drainPolicy') throw err('validation_error', `unknown key ${k}`);
  const drain = body.drainPolicy === undefined ? 'drain-current-node' : String(body.drainPolicy);
  if (drain !== 'immediate' && drain !== 'drain-current-node') throw err('validation_error', 'drainPolicy is immediate | drain-current-node');
  // runs.md §Pause and resume (rc.49/rc.52): a terminal run is 409 run_terminal;
  // any other status that refuses the transition — already paused, waiting on
  // an interrupt, cancelling — is 409 run_state_conflict with
  // details.runStatus naming the status that refused it.
  if (TERMINAL.has(run.status)) throw err('run_terminal', `a ${run.status} run cannot be paused`, { runStatus: run.status });
  // A pause the host has ACCEPTED (202 { status: 'paused' }) but whose loop has
  // not yet observed `pause_requested` is a paused run to the caller — the
  // second pause is refused as such, not accepted twice.
  if (run.status === 'paused' || run.pause_requested === 1) throw err('run_state_conflict', 'the run is already paused', { runStatus: 'paused' });
  if (run.status.startsWith('waiting-') || run.status === 'cancelling') throw err('run_state_conflict', `a run in status ${run.status} cannot be paused`, { runStatus: run.status });
  const r = requestPause(ctx.host, run, typeof body.reason === 'string' ? body.reason : undefined, drain);
  // The 202 says `paused`. Under `immediate` the loop cuts the attempt within
  // one tick (≤ 50 ms), so wait for that tick rather than answer ahead of it —
  // a caller that resumes on the next round trip must find run.paused already
  // on the log. `drain-current-node` may legitimately take as long as the node.
  if (drain === 'immediate' && !r.pausedAt) {
    const until = Date.now() + 500;
    while (Date.now() < until && ctx.host.store.getRun(run.run_id)?.status !== 'paused') await new Promise((res) => setTimeout(res, 10));
  }
  return { status: 202, body: { runId: wireRunId(ctx, run.run_id), status: 'paused', ...(r.pausedAt ? { pausedAt: r.pausedAt } : {}) } };
}

async function resume(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const body = await ctx.json<{ reason?: unknown }>();
  if (TERMINAL.has(run.status)) throw err('run_terminal', `a ${run.status} run cannot be resumed`, { runStatus: run.status });
  if (run.status !== 'paused') throw err('run_state_conflict', 'the run is not paused', { runStatus: run.status });
  const r = requestResume(ctx.host, run, typeof body.reason === 'string' ? body.reason : undefined);
  return { status: 202, body: { runId: run.run_id, status: 'running', resumedAt: r.resumedAt } };
}

async function fork(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const text = await ctx.text();
  return withIdempotency(ctx, 'forkRun', `${run.run_id}|${text}`, async () => {
    const body = parseJsonBody(text);
    const r = forkRun(ctx.host, run, body);
    const wire = wireRunId(ctx, r.runId);
    const prefix = ctx.major === 1 ? '/v1' : '';
    return { status: 201, body: { ...r, runId: wire, eventsUrl: `${ctx.baseUrl}${prefix}/runs/${encodeURIComponent(wire)}/events` } };
  });
}

async function ancestry(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const parent = run.source_run_id === null ? null : { runId: run.source_run_id, hostId: HOST_ID, cause: 'core.subWorkflow' };
  const body = { runId: run.run_id, hostId: HOST_ID, parent };
  ctx.host.validate('run-ancestry-response', body, `ancestry ${run.run_id}`);
  return { status: 200, body };
}

async function createAnnotation(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const body = await ctx.json<Record<string, unknown>>();
  for (const k of Object.keys(body)) if (!['target', 'signal', 'note'].includes(k)) throw err('validation_error', `unknown key ${k}`);
  const signal = body['signal'] as Record<string, unknown> | undefined;
  if (!signal || typeof signal !== 'object') throw err('validation_error', 'signal is REQUIRED');
  const kind = signal['kind'];
  if (!['rating', 'correction', 'label', 'flag'].includes(String(kind))) throw err('validation_error', 'signal.kind is rating | correction | label | flag');
  if (kind === 'rating' && !(Number.isInteger(signal['rating']) && (signal['rating'] as number) >= 1 && (signal['rating'] as number) <= 5)) throw err('validation_error', 'rating 1..5 is required');
  if (kind === 'label' && typeof signal['label'] !== 'string') throw err('validation_error', 'label is required');
  if (kind === 'correction' && typeof signal['correction'] !== 'string') throw err('validation_error', 'correction is required');
  const target: Record<string, unknown> = { runId: run.run_id };
  const t = body['target'] as Record<string, unknown> | undefined;
  if (t && typeof t === 'object') {
    if (t['runId'] !== undefined) throw err('validation_error', 'target.runId comes from the path');
    if (typeof t['eventId'] === 'string') target['eventId'] = t['eventId'];
    if (typeof t['nodeId'] === 'string') { if (!NODE_ID.test(t['nodeId'])) throw err('validation_error', 'target.nodeId grammar'); target['nodeId'] = t['nodeId']; }
  }
  const scrub = (s: string): string => s.replace(/\b(sk-[A-Za-z0-9]{8,}|hk_[A-Za-z0-9_]{8,}|ow2k_[A-Za-z0-9_-]{8,})\b/g, '[redacted]');
  const annotation: Record<string, unknown> = { annotationId: `ann-${nowIso().replace(/[^0-9]/g, '')}-${Math.random().toString(36).slice(2, 8)}`, target, signal: { ...signal, ...(typeof signal['correction'] === 'string' ? { correction: scrub(signal['correction']) } : {}) }, actor: { principalRef: ctx.subject ? principalRef(ctx.subject) : 'anonymous' }, createdAt: nowIso() };
  if (typeof body['note'] === 'string') annotation['note'] = scrub(body['note']);
  ctx.host.validate('annotation', annotation, 'annotation');
  ctx.host.store.insertAnnotation({ annotation_id: String(annotation['annotationId']), run_id: run.run_id, json: JSON.stringify(annotation), created_at: nowIso() });
  ctx.host.bus.emit(`notify:${run.run_id}`, { type: 'run.annotated', annotation });
  return { status: 201, body: annotation };
}

async function listAnnotations(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  return { status: 200, body: { annotations: ctx.host.store.annotationsForRun(run.run_id).map((a) => JSON.parse(a.json)) } };
}

async function compensation(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const body = compensationProjection(ctx.host, run);
  ctx.host.validate('compensation-projection', body, `compensation ${run.run_id}`);
  return { status: 200, body };
}

async function effects(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const body = effectsProjection(ctx.host, run);
  ctx.host.validate('effect-ledger-projection', body, `effects ${run.run_id}`);
  return { status: 200, body };
}

async function manifest(ctx: Ctx): Promise<Reply> {
  const body = effectSeamManifest(ctx.host);
  ctx.host.validate('effect-seam-manifest', body, 'effect-seams');
  return { status: 200, body };
}

async function resolveByRun(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const nodeId = ctx.params['nodeId'] as string;
  const text = await ctx.text();
  return withIdempotency(ctx, 'resolveInterruptByRun', `${run.run_id}|${nodeId}|${text}`, async () => {
    const body = parseJsonBody(text);
    for (const k of Object.keys(body)) if (k !== 'resumeValue') throw err('validation_error', 'the resolve body is { resumeValue } (closed)');
    if (!('resumeValue' in body)) throw err('validation_error', 'resumeValue is REQUIRED');
    const row = ctx.host.store.pendingInterruptForNode(run.run_id, nodeId);
    if (!row) {
      const any = ctx.host.store.listEventRows(run.run_id).some((e) => e.node_id === nodeId && e.type === 'interrupt.requested');
      if (any || TERMINAL.has(run.status)) throw err('interrupt_already_resolved', 'the interrupt was already resolved, or its run is terminal');
      throw err('not_found', 'no pending interrupt on that node');
    }
    const r = resolveAndResume(ctx.host, run, row, body['resumeValue'], ctx.subject);
    return { status: 200, body: r };
  });
}

function tokenRow(ctx: Ctx, token: string): { run: RunRow; row: ReturnType<Host['store']['getInterrupt']> & object } {
  const claims = verifyToken(ctx.host, token);
  const row = ctx.host.store.getInterrupt(claims.i);
  if (!row) throw err('not_found', 'the token names no interrupt on this host');
  const run = ctx.host.store.getRun(row.run_id);
  if (!run) throw err('not_found', 'the token names no run on this host');
  return { run, row };
}

async function inspectByToken(ctx: Ctx): Promise<Reply> {
  const { run, row } = tokenRow(ctx, ctx.params['token'] as string);
  if (row.resolved_at !== null || TERMINAL.has(run.status)) throw err('interrupt_already_resolved', 'the token was invalidated by resolution, cancellation or completion');
  return { status: 200, body: payloadOf(row) };
}

async function resolveByToken(ctx: Ctx): Promise<Reply> {
  const { run, row } = tokenRow(ctx, ctx.params['token'] as string);
  const text = await ctx.text();
  const body = parseJsonBody(text);
  for (const k of Object.keys(body)) if (k !== 'resumeValue') throw err('validation_error', 'the resolve body is { resumeValue } (closed)');
  if (!('resumeValue' in body)) throw err('validation_error', 'resumeValue is REQUIRED');
  const r = resolveAndResume(ctx.host, run, row, body['resumeValue'], null);
  return { status: 200, body: r };
}

/** Host-extension helper (not in the canonical API): the signed token of a pending interrupt, for callers that hold the run. */
async function interruptToken(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const row = ctx.host.store.pendingInterruptForNode(run.run_id, ctx.params['nodeId'] as string);
  if (!row) throw err('not_found', 'no pending interrupt on that node');
  return { status: 200, body: { interruptId: row.interrupt_id, token: mintToken(ctx.host, { i: row.interrupt_id, r: run.run_id, n: row.node_id, e: row.expires_at, t: 'resolve' }), expiresAt: row.expires_at, payload: payloadOf(row) } };
}

async function getWorkflow(ctx: Ctx): Promise<Reply> {
  const def = ctx.host.workflows.get(ctx.params['workflowId'] as string);
  if (!def) throw err('not_found', 'workflow not found');
  return { status: 200, body: def };
}

async function debugEvents(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  return { status: 200, body: { runId: run.run_id, events: readEvents(ctx.host, run) } };
}

export function runRoutes(): Route[] {
  return [
    route('GET', '/workflows/{workflowId}', true, getWorkflow),
    route('POST', '/runs', true, createRun),
    route('POST', '/runs:bulk-cancel', true, bulkCancel),
    route('GET', '/runs/{runId}', true, getRun),
    route('GET', '/runs/{runId}/events', true, stream),
    route('GET', '/runs/{runId}/events/poll', true, poll),
    route('GET', '/runs/{runId}/events/debug', true, debugEvents),
    route('POST', '/runs/{runId}/cancel', true, cancel),
    route('POST', '/runs/{runId}:pause', true, pause),
    route('POST', '/runs/{runId}:resume', true, resume),
    route('POST', '/runs/{runId}:fork', true, fork),
    route('GET', '/runs/{runId}/ancestry', true, ancestry),
    route('POST', '/runs/{runId}/annotations', true, createAnnotation),
    route('GET', '/runs/{runId}/annotations', true, listAnnotations),
    route('GET', '/runs/{runId}/compensation', true, compensation),
    route('GET', '/runs/{runId}/effects', true, effects),
    route('POST', '/runs/{runId}/interrupts/{nodeId}', true, resolveByRun),
    route('GET', '/runs/{runId}/interrupts/{nodeId}', true, interruptToken),
    route('GET', '/interrupts/{token}', false, inspectByToken),
    route('POST', '/interrupts/{token}', false, resolveByToken),
    route('GET', '/host/effect-seams', true, manifest),
    // v1 keys kept through the overlap (versioning.md §1.2, §5)
    route('POST', '/v1/runs', true, createRun, 1),
    route('GET', '/v1/runs/{runId}', true, getRun, 1),
    route('GET', '/v1/runs/{runId}/events', true, stream, 1),
    route('GET', '/v1/runs/{runId}/events/poll', true, poll, 1),
    route('POST', '/v1/runs/{runId}/cancel', true, cancel, 1),
  ];
}

export const VERSION_GRAMMAR = VERSION;
