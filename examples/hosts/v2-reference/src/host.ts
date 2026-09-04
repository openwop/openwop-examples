/**
 * The host context every module receives: config, the durable store, the
 * loaded contract, the in-process event bus (SSE + webhook fan-out subscribe
 * to it), and the fixture catalog.
 */
import { EventEmitter } from 'node:events';
import type { SpecArtifacts } from './artifacts.js';
import type { HostConfig } from './config.js';
import type { Store } from './store.js';
import type { RunEventDoc } from './codemap.js';

export interface Subject {
  issuer: string;
  subjectId: string;
  tenant: string;
  lane: 'api-key' | 'oauth2' | 'oidc' | 'mtls' | 'saml' | 'scim' | 'ldap' | 'workload' | 'session' | 'anonymous';
  kind: 'user' | 'agent' | 'anonymous' | 'workload';
  keyClass?: 'opaque-idp' | 'configured-immutable';
}

export interface Owner {
  tenant: string;
  workspace?: string;
  subject: Subject;
}

export interface WorkflowNode {
  id: string;
  typeId: string;
  name?: string;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name?: string;
  version?: string;
  nodes: WorkflowNode[];
  edges: Array<{ from?: string; to?: string; source?: string; target?: string }>;
  variables: Array<{ name: string; defaultValue?: unknown; required?: boolean }>;
  metadata?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface Host {
  readonly config: HostConfig;
  readonly store: Store;
  readonly artifacts: SpecArtifacts;
  readonly bus: EventEmitter;
  readonly workflows: ReadonlyMap<string, WorkflowDefinition>;
  readonly startedAt: string;
  /** dev-mode schema validation hook (validate.ts); a no-op when off. */
  validate(schemaName: string, doc: unknown, context: string): void;
}

export interface AppendedEvent {
  readonly run: { runId: string; tenant: string; forkMode: string | null; fromSeq: number | null };
  readonly doc: RunEventDoc;
}

export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
