// The production SQL path against a REAL Postgres 16 (postgres.js driver), plus parity with
// PGlite: same migration, same repo round trip, identical result shapes, and real concurrency
// (advisory locks across pool connections, concurrent migrators).
//
// Needs /usr/lib/postgresql/16/bin and runuser (initdb refuses to run as root, so the cluster runs
// as the postgres user in a temp dir under /tmp). Skipped automatically when unavailable.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  connectPostgres,
  createTestDb,
  getDb,
  pgErrorCode,
  setDbForTests,
  type DbConnection,
} from "@/lib/server/db";
import { embeddedMigrations, INIT_SQL, runMigrations } from "@/lib/server/migrate";
import {
  findTripByCode,
  getAppliedOpIds,
  insertTrip,
  loadTripState,
  lockTrip,
  persistWrites,
  readTripState,
  recordAppliedOps,
  ROW_SPECS,
  type ColDef,
} from "@/lib/server/repo";
import { createTrip } from "@/lib/server/trips";
import type { Write } from "@/lib/reducer";
import { newId } from "@/lib/ids";
import { DEFAULT_SETTINGS, ROW_TABLES, type AnyRow, type RowTable, type Trip, type TripState } from "@/lib/types";

const PG_BIN = "/usr/lib/postgresql/16/bin";
const VERSIONS = embeddedMigrations().map((m) => m.version);

function findRunuser(): string | null {
  for (const p of ["/usr/sbin/runuser", "/sbin/runuser", "/usr/bin/runuser", "/bin/runuser"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function postgresIds(): { uid: number; gid: number } | null {
  const u = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
  const g = spawnSync("id", ["-g", "postgres"], { encoding: "utf8" });
  if (u.status !== 0 || g.status !== 0) return null;
  return { uid: Number(u.stdout.trim()), gid: Number(g.stdout.trim()) };
}

const RUNUSER = findRunuser();
const PG_IDS = postgresIds();
const AVAILABLE =
  process.platform === "linux" &&
  typeof process.getuid === "function" &&
  process.getuid() === 0 &&
  !!RUNUSER &&
  !!PG_IDS &&
  fs.existsSync(path.join(PG_BIN, "initdb")) &&
  fs.existsSync(path.join(PG_BIN, "pg_ctl"));

function asPostgres(args: string[]): void {
  const r = spawnSync(RUNUSER!, ["-u", "postgres", "--", ...args], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Sample data generated from the column specs (deterministic, so both drivers get identical rows)
// ---------------------------------------------------------------------------

let seq = 0;
function fixedUuid(): string {
  seq++;
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}
function fixedIso(n: number): string {
  return new Date(Date.UTC(2026, 9, 24, 16, 50, 0, 0) + n * 1_003).toISOString();
}

function sampleRow(table: RowTable, tripId: string, filled: boolean, i: number): AnyRow {
  const row: Record<string, unknown> = {};
  let n = 0;
  for (const [col, def] of Object.entries(ROW_SPECS[table].columns as Record<string, ColDef>)) {
    n++;
    const nullable = typeof def === "object" ? !!def.nullable : def.endsWith("?");
    if (nullable && !filled) {
      row[col] = null;
      continue;
    }
    if (typeof def === "object") {
      row[col] = def.enum[(i + n) % def.enum.length];
      continue;
    }
    switch (def.replace("?", "")) {
      case "uuid":
        row[col] = fixedUuid();
        break;
      case "text":
        row[col] = col === "pot_key" ? `contest:${3 + i}` : `${col} ${i} "q" it's ⛳ 🍺 \\ back`;
        break;
      case "int":
        row[col] = col === "number" || col === "hole" ? 40 + i : n * 3 + i;
        break;
      case "float":
        row[col] = -75.6480123456789 + i + n / 7;
        break;
      case "bool":
        row[col] = (i + n) % 2 === 0;
        break;
      case "ts":
        row[col] = fixedIso(i * 100 + n);
        break;
      case "jsonb":
        row[col] = { "3": fixedIso(n), list: [1, 2.5, "x", null, false, { y: [] }], unicode: "ü✓", i };
        break;
      case "int[]":
        row[col] = [1, 7, 18].slice(0, 1 + (i % 3));
        break;
    }
  }
  row.trip_id = tripId;
  return row as unknown as AnyRow;
}

function fixedTrip(code: string): Trip {
  return {
    id: fixedUuid(),
    code,
    name: "Parity Trip",
    app_name: "Scramble",
    status: "live",
    base_team_size: 4,
    settings: { ...DEFAULT_SETTINGS, team_match_payout: [70, 30], drink_cap: null },
    is_demo: false,
    created_at: fixedIso(1),
    started_at: fixedIso(2),
    finalized_at: null,
    updated_at: fixedIso(3),
  };
}

const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

/** Seed identical data and return the loaded state. */
async function seedParity(db: DbConnection, code: string): Promise<{ trip: Trip; state: TripState; expected: Record<string, AnyRow[]> }> {
  seq = 1000; // same ids on both drivers
  const trip = await insertTrip(db, fixedTrip(code), "scrypt$x$y");
  const expected: Record<string, AnyRow[]> = {};
  const writes: Write[] = [];
  for (const table of ROW_TABLES) {
    expected[table] = [0, 1, 2].map((i) => sampleRow(table, trip.id, i !== 1, i));
    for (const row of expected[table]) writes.push({ kind: "upsert", table, row });
  }
  writes.push({ kind: "trip", row: { ...trip, status: "final", finalized_at: fixedIso(9), updated_at: fixedIso(9) } });
  writes.push({ kind: "delete", table: "drinks", id: expected.drinks[2].id });
  const res = await persistWrites(db, trip.id, writes);
  expect(res.skipped).toEqual([]);
  expected.drinks = expected.drinks.slice(0, 2);
  return { trip, state: await loadTripState(db, trip.id), expected };
}

const PROBE_SQL = `select '2026-10-24T16:50:00.123Z'::timestamptz as ts, null::timestamptz as nts,
  '{"a":[1,{"b":null}],"s":"x"}'::jsonb as j, '[1,2]'::jsonb as ja, array[3,1,2]::int[] as arr,
  '{}'::int[] as empty, 1.25::double precision as d, 7::integer as i, count(*) as n,
  9007199254740993::bigint as huge, 12::bigint as small, true as b, 'it''s'::text as s,
  gen_random_uuid() is not null as has_uuid, 1.5::numeric as num`;
const PARAM_SQL = "select $1::timestamptz as t, $2::text as u, $3::jsonb as o, $4::jsonb as raw, $5::int[] as a, $6::uuid[] as ids, $7::boolean as b, $8::double precision as f, $9::text as w, $10::jsonb as wj";
const PARAMS = () => [new Date("2026-10-24T16:50:00.007Z"), undefined, { k: [1, "two"] }, '{"r":true}', [5, 6], ["00000000-0000-4000-8000-000000000001"], false, 0.1, "x\ud83c\u0000y", { e: "\udc00" }];

// ---------------------------------------------------------------------------

describe.skipIf(!AVAILABLE)("real Postgres 16", () => {
  let dir = "";
  let url = "";
  let pg: DbConnection;
  let lite: DbConnection;
  let started = false;

  beforeAll(async () => {
    dir = fs.mkdtempSync("/tmp/scramble-pg-");
    fs.chownSync(dir, PG_IDS!.uid, PG_IDS!.gid);
    asPostgres([path.join(PG_BIN, "initdb"), "-D", path.join(dir, "data"), "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--no-locale", "--no-sync"]);
    const port = await freePort();
    asPostgres([
      path.join(PG_BIN, "pg_ctl"),
      "-D",
      path.join(dir, "data"),
      "-l",
      path.join(dir, "postgres.log"),
      "-w",
      "-t",
      "60",
      "-o",
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c TimeZone=America/New_York`,
      "start",
    ]);
    started = true;
    url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    pg = await connectPostgres(url);
    lite = await createTestDb();
  }, 180_000);

  afterAll(async () => {
    setDbForTests(null);
    await closeDb().catch(() => {});
    await pg?.close().catch(() => {});
    await lite?.close().catch(() => {});
    if (started) {
      try {
        asPostgres([path.join(PG_BIN, "pg_ctl"), "-D", path.join(dir, "data"), "-m", "immediate", "-w", "stop"]);
      } catch (e) {
        console.warn(String(e));
      }
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("is really Postgres 16 over postgres.js", async () => {
    expect(pg.driver).toBe("postgres");
    const [{ v }] = await pg.query<{ v: string }>("select current_setting('server_version_num') as v");
    expect(Number(v)).toBeGreaterThanOrEqual(160000);
    expect(Number(v)).toBeLessThan(170000);
  });

  it("applies the migration once; the SQL is idempotent; RLS on every table", async () => {
    expect(await runMigrations(pg)).toEqual(VERSIONS);
    expect(await runMigrations(pg)).toEqual([]);
    await pg.exec(INIT_SQL);
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(rls.length).toBe(21);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    // Same columns as PGlite (catalog parity).
    const colsSql = `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
                     where table_schema = 'public' order by table_name, ordinal_position`;
    expect(await pg.query(colsSql)).toEqual(await lite.query(colsSql));
  });

  it("concurrent migrators on a fresh database apply exactly once", async () => {
    await pg.exec("drop database if exists scramble_mig");
    await pg.exec("create database scramble_mig");
    const migUrl = url.replace(/\/postgres$/, "/scramble_mig");
    const a = await connectPostgres(migUrl);
    const b = await connectPostgres(migUrl);
    try {
      const [ra, rb] = await Promise.all([runMigrations(a), runMigrations(b)]);
      expect([...ra, ...rb]).toEqual(VERSIONS);
      const v = await a.query("select version from schema_migrations order by version");
      expect(v).toEqual(VERSIONS.map((version) => ({ version })));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("normalizes results and params exactly like PGlite", async () => {
    const [p] = await pg.query(PROBE_SQL);
    const [l] = await lite.query(PROBE_SQL);
    expect(p).toEqual(l);
    expect(p).toMatchObject({ ts: "2026-10-24T16:50:00.123Z", n: 1, huge: "9007199254740993", small: 12, arr: [3, 1, 2], num: "1.5" });
    const [pp] = await pg.query(PARAM_SQL, PARAMS());
    const [lp] = await lite.query(PARAM_SQL, PARAMS());
    expect(pp).toEqual(lp);
    expect(pp).toEqual({
      t: "2026-10-24T16:50:00.007Z",
      u: null,
      o: { k: [1, "two"] },
      raw: { r: true },
      a: [5, 6],
      ids: ["00000000-0000-4000-8000-000000000001"],
      b: false,
      f: 0.1,
      w: "x\ufffdy",
      wj: { e: "\ufffd" },
    });
  });

  it("round-trips every table deep-equal, identically on both drivers", async () => {
    const onPg = await seedParity(pg, "paritycode1");
    const onLite = await seedParity(lite, "paritycode1");
    expect(onPg.state).toEqual(onLite.state); // same rows, same order, same shapes
    for (const t of ROW_TABLES) {
      expect(byId(onPg.state[t] as AnyRow[]), t).toEqual(byId(onPg.expected[t]));
    }
    expect(onPg.state.trip).toMatchObject({ status: "final", finalized_at: fixedIso(9), code: "paritycode1" });
    expect((await findTripByCode(pg, "paritycode1"))?.pin_hash).toBe("scrypt$x$y");
    // The snapshot read (repeatable-read, read-only tx; queries pipelined on one connection).
    expect(await readTripState(pg, onPg.trip.id)).toEqual(onPg.state);
    expect(await pg.tx(async (t) => {
      await lockTrip(t, onPg.trip.id);
      return readTripState(t, onPg.trip.id); // nested → savepoint
    })).toEqual(onPg.state);
  });

  it("createTrip + applied ops + unique violations surface as SQLSTATE codes", async () => {
    const trip = await createTrip(pg, { name: "Real PG", app_name: "Scramble", pin_hash: "scrypt$a$b" });
    const state = await loadTripState(pg, trip.id);
    expect(state.holes).toHaveLength(18);
    const op = newId();
    expect(await recordAppliedOps(pg, [{ id: op, trip_id: trip.id, op_type: "tee.open", status: "applied" }])).toBe(1);
    expect(await recordAppliedOps(pg, [{ id: op, trip_id: trip.id, op_type: "tee.open", status: "applied" }])).toBe(0);
    expect(await getAppliedOpIds(pg, trip.id, [op, newId()])).toEqual(new Set([op]));
    let code: string | undefined;
    try {
      await pg.query("insert into holes (id, trip_id, number, par, stroke_index) values ($1, $2, 1, 4, 1)", [newId(), trip.id]);
    } catch (e) {
      code = pgErrorCode(e);
    }
    expect(code).toBe("23505");
  });

  it("transactions roll back, nest with savepoints, and honor read-only", async () => {
    await pg.exec("create table if not exists tx_probe (id integer primary key)");
    await expect(
      pg.tx(async (t) => {
        await t.query("insert into tx_probe values (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await pg.tx(async (t) => {
      await t.query("insert into tx_probe values (2)");
      await expect(t.tx(async (i) => {
        await i.query("insert into tx_probe values (3)");
        throw new Error("inner");
      })).rejects.toThrow("inner");
    });
    expect(await pg.query("select id from tx_probe order by id")).toEqual([{ id: 2 }]);
    await expect(pg.tx((t) => t.query("insert into tx_probe values (4)"), { readOnly: true })).rejects.toThrow();
  });

  it("a failed SQL statement caught inside a savepoint doesn't doom the outer transaction", async () => {
    await pg.exec("create table if not exists tx_probe2 (id integer primary key)");
    await pg.tx(async (t) => {
      await t.query("insert into tx_probe2 values (1)");
      await expect(t.tx((i) => i.query("insert into tx_probe2 values (1)"))).rejects.toThrow(); // duplicate key
      await t.query("insert into tx_probe2 values (2)");
    });
    expect(await pg.query("select id from tx_probe2 order by id")).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("lockTrip serializes writers of one trip across pool connections (no lost updates)", async () => {
    const trip = await createTrip(pg, { name: "Lock", app_name: "Scramble", pin_hash: "scrypt$a$b" });
    const other = await createTrip(pg, { name: "Other", app_name: "Scramble", pin_hash: "scrypt$a$b" });
    await pg.exec("create table if not exists lock_counter (trip_id uuid primary key, n integer not null)");
    await pg.query("insert into lock_counter values ($1, 0), ($2, 0)", [trip.id, other.id]);

    // Read-modify-write with a pause in between: without the lock, increments would be lost.
    const bump = (tripId: string) =>
      pg.tx(async (t) => {
        await lockTrip(t, tripId);
        const [{ n }] = await t.query<{ n: number }>("select n from lock_counter where trip_id = $1", [tripId]);
        await new Promise((r) => setTimeout(r, 15));
        await t.query("update lock_counter set n = $2 where trip_id = $1", [tripId, n + 1]);
      });
    await Promise.all([...Array.from({ length: 8 }, () => bump(trip.id)), ...Array.from({ length: 4 }, () => bump(other.id))]);
    const rows = await pg.query<{ trip_id: string; n: number }>("select trip_id, n from lock_counter");
    expect(Object.fromEntries(rows.map((r) => [r.trip_id, r.n]))).toEqual({ [trip.id]: 8, [other.id]: 4 });

    // A second transaction waits while the first holds the lock.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const events: string[] = [];
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const first = pg.tx(async (t) => {
      await lockTrip(t, trip.id);
      events.push("first locked");
      holding();
      await gate;
      events.push("first done");
    });
    await held;
    const second = pg.tx(async (t) => {
      await lockTrip(t, trip.id);
      events.push("second locked");
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual(["first locked"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first locked", "first done", "second locked"]);
  });

  it("getDb() uses DATABASE_URL (postgres driver) and migrates on first use", async () => {
    vi.stubEnv("DATABASE_URL", url);
    try {
      setDbForTests(null);
      await closeDb();
      const [{ app }] = await getDb().query<{ app: string }>("select current_setting('application_name') as app");
      expect(app).toBe("scramble");
      const versions = await getDb().query("select version from schema_migrations order by version");
      expect(versions).toEqual(VERSIONS.map((version) => ({ version })));
    } finally {
      await closeDb();
      vi.unstubAllEnvs();
    }
  });
});

describe.runIf(!AVAILABLE)("real Postgres 16 (unavailable)", () => {
  it.skip("skipped: needs root, runuser and /usr/lib/postgresql/16/bin", () => {});
});
