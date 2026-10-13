// Database access: one tiny interface over two drivers.
//
//   DATABASE_URL set   → Supabase Postgres via postgres.js (porsager), prepare:false for the
//                        Supavisor transaction pooler.
//   DATABASE_URL unset → PGlite (embedded Postgres in WASM) at PGLITE_DIR (default .data/pglite;
//                        "memory://" for an in-memory database).
//
// Both run the same SQL ($1-style params) and return rows of identical shape:
//   timestamptz → ISO string ("2026-10-24T16:50:00.000Z"), jsonb → parsed objects,
//   int[] → number[], integer/double precision → number, int8 (e.g. count(*)) → number
//   (string if beyond 2^53), numeric → string (cast in SQL if you need a number).
// Param conventions: pass jsonb as objects/arrays (a string is taken as raw JSON text), int[] as
// number[], timestamptz as ISO strings or Dates, undefined → null. Strings (also inside objects)
// are cleaned of NUL characters and lone surrogates, which Postgres would reject.
//
// Transactions: db.tx(fn) runs fn with a handle bound to ONE connection. Inside fn ALWAYS use the
// handle you were given: on PGlite (single connection) a query on the root db while a transaction
// is open waits for that transaction to finish, so awaiting it inside fn deadlocks. Nested
// tx() calls on a handle use savepoints. Don't keep a tx handle after tx() returns.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { databaseUrl, pgliteDir } from "./env";
import { runMigrations } from "./migrate";

export type Isolation = "read committed" | "repeatable read" | "serializable";

export interface TxOptions {
  /** Only honored on the outermost transaction (nested ones are savepoints). */
  isolation?: Isolation;
  readOnly?: boolean;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>, opts?: TxOptions): Promise<T>;
}

/** A Db that can also run multi-statement scripts (no params), e.g. migrations. */
export interface SqlDb extends Db {
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: SqlDb) => Promise<T>, opts?: TxOptions): Promise<T>;
}

/** An open connection (pool) you own and must close. */
export interface DbConnection extends SqlDb {
  readonly driver: "pglite" | "postgres";
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Result / param normalization (shared by both drivers)
// ---------------------------------------------------------------------------

/** Normalize one value coming out of a driver. */
export function normalizeValue(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  // Postgres arrays (int[], timestamptz[]...) and jsonb arrays. jsonb never contains Dates or
  // bigints, so walking it is a harmless no-op.
  if (Array.isArray(v)) return v.map(normalizeValue);
  return v;
}

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = normalizeValue(row[k]);
  return out;
}

/**
 * Postgres rejects NUL characters in text/jsonb and lone UTF-16 surrogates in JSON (a sliced emoji
 * from a buggy client would otherwise fail a whole sync batch). Clean them out of every param.
 */
export function cleanString(s: string): string {
  const w = s.isWellFormed() ? s : s.toWellFormed();
  return w.includes("\u0000") ? w.replace(/\u0000/g, "") : w;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function cleanDeep(v: unknown): unknown {
  if (typeof v === "string") return cleanString(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v && typeof v === "object" && isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[cleanString(k)] = cleanDeep(x);
    return out;
  }
  return v;
}

function normalizeParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  return cleanDeep(v);
}

// ---------------------------------------------------------------------------
// Driver adapters
// ---------------------------------------------------------------------------

interface Runner {
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<void>;
  /**
   * Driver-native savepoint (postgres.js). postgres.js remembers the first failed query inside
   * begin() and rethrows it at the end, so a hand-rolled "rollback to savepoint" can't recover from
   * a failed statement; its scoped sql.savepoint(fn) can. Absent on PGlite (manual savepoints work).
   */
  savepoint?<T>(fn: (r: Runner) => Promise<T>): Promise<T>;
}

interface Driver extends Runner {
  readonly name: "pglite" | "postgres";
  transaction<T>(fn: (r: Runner) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function pgliteDriver(dataDir: string): Promise<Driver> {
  const { PGlite } = await import("@electric-sql/pglite");
  const memory = dataDir.startsWith("memory://");
  let target = dataDir;
  if (!memory) {
    target = path.resolve(dataDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const pg = await PGlite.create(target);
  type Q = { query: typeof pg.query; exec: typeof pg.exec };
  const runner = (q: Q): Runner => ({
    query: async (sql, params) => (await q.query<Record<string, unknown>>(sql, params)).rows,
    exec: async (sql) => {
      await q.exec(sql);
    },
  });
  return {
    name: "pglite",
    ...runner(pg),
    // PGlite serializes everything on its single connection; transaction() holds it exclusively.
    transaction: (fn) => pg.transaction((t) => fn(runner(t))),
    close: () => pg.close(),
  };
}

/** TLS for remote hosts unless the URL says otherwise (Supabase requires it; local PG has none). */
function sslFor(url: string): false | "require" | undefined {
  if (/[?&]sslmode=/i.test(url)) return undefined; // let postgres.js read it from the URL
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
  return "require";
}

async function postgresDriver(url: string): Promise<Driver> {
  const { default: postgres } = await import("postgres");
  const ssl = sslFor(url);
  const sql = postgres(url, {
    prepare: false, // Supavisor transaction mode can't keep named prepared statements
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    ...(ssl === undefined ? {} : { ssl }),
    onnotice: () => {}, // "relation already exists, skipping" etc.
    transform: { undefined: null },
    connection: { application_name: "scramble" },
    types: {
      // Same semantics as PGlite: a string is raw JSON text, anything else is JSON.stringify'd.
      // (postgres.js's default would double-encode a pre-stringified value.)
      json: {
        to: 3802,
        from: [114, 3802],
        serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)),
        parse: (x: string) => JSON.parse(x),
      },
      // int8 (count(*), sum(int)) as a number like PGlite, instead of postgres.js's string.
      int8: {
        to: 20,
        from: [20],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => {
          const n = Number(x);
          return Number.isSafeInteger(n) ? n : x;
        },
      },
    },
  });
  type Unsafe = {
    unsafe: (typeof sql)["unsafe"];
    savepoint?: (fn: (sp: Unsafe) => Promise<unknown>) => Promise<unknown>;
  };
  const runner = (q: Unsafe): Runner => ({
    query: async (text, params) =>
      Array.from(await q.unsafe(text, params as never[])) as unknown as Record<string, unknown>[],
    exec: async (text) => {
      await q.unsafe(text); // no params → simple protocol → multiple statements allowed
    },
    // Only transaction-scoped sql objects have savepoint().
    ...(typeof q.savepoint === "function"
      ? { savepoint: async <T>(fn: (r: Runner) => Promise<T>) => (await q.savepoint!((sp) => fn(runner(sp)))) as T }
      : {}),
  });
  return {
    name: "postgres",
    ...runner(sql),
    transaction: async <T>(fn: (r: Runner) => Promise<T>): Promise<T> =>
      (await sql.begin((t) => fn(runner(t as unknown as Unsafe)))) as T,
    close: () => sql.end({ timeout: 5 }),
  };
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

interface TxScope {
  root: object;
  active: boolean;
}

/** Which transaction (if any) the current async context is inside. Used only to warn. */
const txScope = new AsyncLocalStorage<TxScope>();
let warnedRootInTx = false;

function setTransactionSql(opts: TxOptions): string | null {
  const parts: string[] = [];
  if (opts.isolation) parts.push(`isolation level ${opts.isolation}`);
  if (opts.readOnly) parts.push("read only");
  return parts.length ? `set transaction ${parts.join(", ")}` : null;
}

function makeHandle(driver: Driver, runner: Runner, scope: TxScope | null, root: object): SqlDb {
  let savepoints = 0;

  const check = () => {
    if (scope) {
      if (!scope.active) throw new Error("db: transaction already finished (a tx handle was used after tx() returned)");
      return;
    }
    const s = txScope.getStore();
    if (s && s.active && s.root === root && !warnedRootInTx) {
      warnedRootInTx = true;
      console.warn(
        "db: query on the root db while a transaction is open in this async context. Use the handle " +
          "passed to tx(); on PGlite this waits for the transaction to finish (deadlock if awaited).\n" +
          new Error().stack,
      );
    }
  };

  const handle: SqlDb = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      check();
      const rows = await runner.query(sql, params.map(normalizeParam));
      return rows.map(normalizeRow) as T[];
    },
    async exec(sql: string): Promise<void> {
      check();
      await runner.exec(sql);
    },
    async tx<T>(fn: (db: SqlDb) => Promise<T>, opts: TxOptions = {}): Promise<T> {
      if (scope) {
        // Nested: a savepoint on the same connection.
        check();
        if (runner.savepoint) return runner.savepoint((r) => fn(makeHandle(driver, r, scope, root)));
        const name = `scramble_sp_${++savepoints}`;
        await runner.query(`savepoint ${name}`, []);
        try {
          const result = await fn(handle);
          await runner.query(`release savepoint ${name}`, []);
          return result;
        } catch (e) {
          await runner.query(`rollback to savepoint ${name}`, []).catch(() => {});
          throw e;
        }
      }
      return driver.transaction(async (txRunner) => {
        const s: TxScope = { root, active: true };
        try {
          return await txScope.run(s, async () => {
            const set = setTransactionSql(opts);
            if (set) await txRunner.query(set, []);
            return fn(makeHandle(driver, txRunner, s, root));
          });
        } finally {
          s.active = false;
        }
      });
    },
  };
  return handle;
}

function connection(driver: Driver): DbConnection {
  const root = {};
  const handle = makeHandle(driver, driver, null, root);
  return {
    driver: driver.name,
    query: handle.query,
    exec: handle.exec,
    tx: handle.tx,
    close: () => driver.close(),
  };
}

/** Open PGlite (no migrations). dataDir: a directory path or "memory://". */
export async function connectPglite(dataDir: string = "memory://"): Promise<DbConnection> {
  return connection(await pgliteDriver(dataDir));
}

/** Open a postgres.js pool (no migrations). */
export async function connectPostgres(url: string): Promise<DbConnection> {
  return connection(await postgresDriver(url));
}

/** Open the database the environment points at and apply pending migrations. */
export async function openDb(): Promise<DbConnection> {
  const url = databaseUrl();
  const conn = url ? await connectPostgres(url) : await connectPglite(pgliteDir());
  try {
    await runMigrations(conn);
  } catch (e) {
    await conn.close().catch(() => {});
    throw e;
  }
  return conn;
}

/** A fresh in-memory PGlite with migrations applied. Close it when done. */
export async function createTestDb(): Promise<DbConnection> {
  const conn = await connectPglite("memory://");
  await runMigrations(conn);
  return conn;
}

// ---------------------------------------------------------------------------
// Process-wide singleton (cached on globalThis so it survives dev HMR)
// ---------------------------------------------------------------------------

interface Holder {
  conn?: Promise<DbConnection>;
  override?: Db | null;
}

const G = globalThis as typeof globalThis & { __scrambleDb?: Holder };
const holder: Holder = (G.__scrambleDb ??= {});

/** The connection (opened + migrated once per process). */
export function getConnection(): Promise<DbConnection> {
  if (!holder.conn) {
    const p = openDb();
    holder.conn = p;
    // A failed open (DB unreachable) is retried on the next request instead of cached forever.
    p.catch(() => {
      if (holder.conn === p) holder.conn = undefined;
    });
  }
  return holder.conn;
}

function current(): Promise<Db> {
  return holder.override ? Promise.resolve(holder.override) : getConnection();
}

/**
 * The app database. Lazy: the first query opens the connection and runs migrations.
 * `getDb().query(...)` and `(await getDb()).query(...)` both work.
 */
export function getDb(): Db {
  return lazyDb;
}

const lazyDb: Db = {
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return (await current()).query<T>(sql, params);
  },
  async tx<T>(fn: (db: Db) => Promise<T>, opts?: TxOptions): Promise<T> {
    return (await current()).tx(fn, opts);
  },
};

/** Tests: route getDb() to this database (null restores the real one). */
export function setDbForTests(db: Db | null): void {
  holder.override = db;
}

/** Close the singleton connection (scripts call this before exiting). */
export async function closeDb(): Promise<void> {
  const p = holder.conn;
  holder.conn = undefined;
  if (p) await (await p.catch(() => null))?.close();
}

/** SQLSTATE of a driver error (both drivers expose `.code`), e.g. "23505" unique violation. */
export function pgErrorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export const UNIQUE_VIOLATION = "23505";
