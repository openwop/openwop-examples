/**
 * The database seam: one interface, two backends.
 *
 *   - `pg` — a real Postgres at `OPENWOP_PG_DSN`. Queries go through a
 *     `pg.Pool`; a transaction checks out one pooled client for its duration;
 *     the advisory-lock session is a separate `pg.Client` held for the life of
 *     the process (see `lockSession`).
 *   - `pglite` — Postgres compiled to WASM, in this process
 *     (`@electric-sql/pglite`). In memory by default, or a data directory with
 *     `OPENWOP_PGLITE_DIR`. One connection, so it is one process's database:
 *     the tests and the conformance suite run on it without a Postgres server.
 *
 * `Querier` is the narrow surface both satisfy (`query(sql, params)` returning
 * `{ rows, rowCount }`), so `audit.ts` and `audit-export.ts` take any of them,
 * including a bare PGlite wrapped in a test.
 */
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T = Record<string, unknown>> {
  readonly rows: T[];
  readonly rowCount?: number | undefined;
}

export interface Querier {
  query<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult<T>>;
}

/** A connection that stays open for the life of the process; it reports when it is lost. */
export interface Session extends Querier {
  onLost(cb: (e: Error) => void): void;
  close(): Promise<void>;
}

export interface Database extends Querier {
  readonly kind: 'pg' | 'pglite';
  /** Run `fn` inside one transaction on one connection: COMMIT on return, ROLLBACK on throw. */
  transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T>;
  /**
   * The connection this process's session-level advisory locks live on. On
   * `pg` it is its own `pg.Client`, outside the pool, so a lock is held by a
   * connection whose lifetime is the process's: if the process dies, the
   * connection drops and Postgres releases every lock it held.
   */
  lockSession(): Promise<Session>;
  close(): Promise<void>;
}

/**
 * A transaction on any Querier. A `Database` runs it on one connection; a bare
 * Querier (one connection, as a test's PGlite is) gets BEGIN/COMMIT with an
 * in-process FIFO, so two overlapping callers cannot interleave their
 * statements inside one transaction.
 */
let txTail: Promise<void> = Promise.resolve();
export async function withTransaction<T>(q: Querier, fn: (tx: Querier) => Promise<T>): Promise<T> {
  if (typeof (q as Partial<Database>).transaction === 'function') return (q as Database).transaction(fn);
  let release!: () => void;
  const ticket = new Promise<void>((r) => { release = r; });
  const wait = txTail;
  txTail = ticket;
  await wait;
  try {
    await q.query('BEGIN');
    try {
      const result = await fn(q);
      await q.query('COMMIT');
      return result;
    } catch (e) {
      try { await q.query('ROLLBACK'); } catch { /* surface the original error */ }
      throw e;
    }
  } finally {
    release();
  }
}

/** A real Postgres. */
export function connectPg(dsn: string, poolSize = 10): Database {
  const pool = new pg.Pool({ connectionString: dsn, max: poolSize });
  // An idle pooled client that errors is discarded by the pool; without a listener the error would crash the process.
  pool.on('error', (e) => console.error('[openwop-host-postgres] idle pool client error:', e.message));
  return {
    kind: 'pg',
    query: async <T>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      const tx: Querier = {
        query: async <R>(sql: string, params: ReadonlyArray<unknown> = []) => {
          const r = await client.query(sql, params as unknown[]);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
        },
      };
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* surface the original error */ }
        throw e;
      } finally {
        client.release();
      }
    },
    lockSession: async (): Promise<Session> => {
      const client = new pg.Client({ connectionString: dsn });
      const lost: Array<(e: Error) => void> = [];
      let closing = false;
      const fire = (e: Error): void => { if (!closing) for (const cb of lost.splice(0)) cb(e); };
      client.on('error', fire);
      client.on('end', () => fire(new Error('the lock session ended')));
      await client.connect();
      return {
        query: async <R>(sql: string, params: ReadonlyArray<unknown> = []) => {
          const r = await client.query(sql, params as unknown[]);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
        },
        onLost: (cb) => { lost.push(cb); },
        close: async () => { closing = true; await client.end(); },
      };
    },
    close: async () => { await pool.end(); },
  };
}

/** Postgres in this process: `dataDir` undefined is in memory. */
export async function openPglite(dataDir?: string): Promise<Database> {
  const db = new PGlite(dataDir ?? 'memory://');
  await db.waitReady;
  const wrap = (x: { query: PGlite['query'] }): Querier => ({
    query: async <T>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const r = await x.query<T>(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
    },
  });
  const direct = wrap(db);
  return {
    kind: 'pglite',
    query: direct.query,
    // PGlite queues every other query behind an open transaction.
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => db.transaction(async (tx) => fn(wrap(tx))),
    // One connection: the session is the database itself, and it is never lost.
    lockSession: async (): Promise<Session> => ({ query: direct.query, onLost: () => {}, close: async () => {} }),
    close: async () => { await db.close(); },
  };
}
