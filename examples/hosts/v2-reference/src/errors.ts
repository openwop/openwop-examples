/**
 * errors.md — every error a v2 host returns is a row in spec/v2/errors.json.
 * The registry decides the HTTP status; the body is the flat closed envelope
 * `{ error, message, details? }`; retry timing travels in `Retry-After` only.
 */
import { loadArtifacts } from './artifacts.js';

export class HostError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;

  constructor(code: string, message: string, details?: Record<string, unknown>, headers: Record<string, string> = {}) {
    super(message);
    const row = loadArtifacts().errors.get(code);
    if (row === undefined) {
      // A producer MUST NOT emit an unregistered member (overview.md §0).
      throw new Error(`unregistered error code emitted by the host: ${code}`);
    }
    this.code = code;
    this.status = row.httpStatus;
    this.details = details;
    this.headers = headers;
  }

  body(): { error: string; message: string; details?: Record<string, unknown> } {
    return this.details === undefined ? { error: this.code, message: this.message } : { error: this.code, message: this.message, details: this.details };
  }
}

export function err(code: string, message: string, details?: Record<string, unknown>, headers?: Record<string, string>): HostError {
  return new HostError(code, message, details, headers);
}

export function isRetriable(code: string): boolean {
  return loadArtifacts().errors.get(code)?.retriable === true;
}
