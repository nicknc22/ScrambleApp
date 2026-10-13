// Database layer: migrations, schema shape vs. the row types, driver normalization, transactions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanString, createTestDb, getDb, normalizeRow, normalizeValue, setDbForTests, type DbConnection } from "@/lib/server/db";
import { ABUSE_LIMITS_SQL, embeddedMigrations, INIT_SQL, loadMigrations, migrationsDir, runMigrations } from "@/lib/server/migrate";
import { ROW_SPECS, TRIP_SPEC, type ColDef } from "@/lib/server/repo";
import { ROW_TABLES } from "@/lib/types";

let db: DbConnection;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

const ALL_TABLES = [
  "schema_migrations",
  "trips",
  ...ROW_TABLES,
  "push_subscriptions",
  "push_log",
  "ai_log",
  "applied_ops",
  "pin_failures",
  "photo_uploads",
  "demo_creations",
];
/** Server-wide bookkeeping that outlives any one trip (no trips FK). */
const GLOBAL_TABLES = ["schema_migrations", "trips", "demo_creations"];
const VERSIONS = ["001_init", "002_abuse_limits"];

describe("migrations", () => {
  it("embedded SQL is byte-identical to db/migrations/*.sql, and every file is embedded", () => {
    expect(INIT_SQL).toBe(fs.readFileSync(path.join(process.cwd(), "db/migrations/001_init.sql"), "utf8"));
    expect(ABUSE_LIMITS_SQL).toBe(fs.readFileSync(path.join(process.cwd(), "db/migrations/002_abuse_limits.sql"), "utf8"));
    const files = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql"));
    const embedded = new Map(embeddedMigrations().map((m) => [m.version, m.sql]));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const version = f.replace(/\.sql$/, "");
      expect(embedded.has(version), `${f} has no embedded copy in migrate.ts`).toBe(true);
      expect(embedded.get(version)).toBe(fs.readFileSync(path.join(migrationsDir(), f), "utf8"));
    }
    expect(embedded.size).toBe(files.length);
  });

  it("loads from disk, sorted, and falls back to the embedded copies without the folder", () => {
    const fromDisk = loadMigrations();
    expect(fromDisk.map((m) => m.version)).toEqual([...fromDisk.map((m) => m.version)].sort());
    expect(fromDisk[0].version).toBe("001_init");
    const missing = loadMigrations(path.join(os.tmpdir(), "definitely-not-here-" + Date.now()));
    expect(missing).toEqual(embeddedMigrations());
  });

  it("creates every table and records the version", async () => {
    const rows = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of ALL_TABLES) expect(names.has(t), t).toBe(true);
    const versions = await db.query<{ version: string }>("select version from schema_migrations order by version");
    expect(versions.map((v) => v.version)).toEqual(VERSIONS);
  });

  it("is a no-op the second time, and the SQL itself is idempotent", async () => {
    expect(await runMigrations(db)).toEqual([]);
    await db.exec(INIT_SQL); // pasting it into the SQL editor again must not break anything
    await db.exec(ABUSE_LIMITS_SQL);
    const versions = await db.query("select version from schema_migrations");
    expect(versions).toHaveLength(VERSIONS.length);
  });

  it("applies 002 on top of a database that only had 001 (an existing deploy)", async () => {
    const old = await createTestDb();
    try {
      // Simulate the pre-002 database: drop what 002 adds and forget it ran.
      await old.exec("drop table pin_failures; drop table photo_uploads; drop table demo_creations; delete from schema_migrations where version = '002_abuse_limits'");
      expect(await runMigrations(old)).toEqual(["002_abuse_limits"]);
      const rows = await old.query<{ n: number }>(
        "select count(*)::int as n from information_schema.tables where table_name in ('pin_failures', 'photo_uploads', 'demo_creations')",
      );
      expect(rows[0].n).toBe(3);
    } finally {
      await old.close();
    }
  });

  it("enables RLS on every table and defines no policies", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(rls.length).toBe(ALL_TABLES.length);
    for (const r of rls) expect(r.relrowsecurity, r.relname).toBe(true);
    const policies = await db.query<{ n: number }>("select count(*) as n from pg_policy");
    expect(policies[0].n).toBe(0);
  });

  it("gives every child table a cascading trips FK, an index on trip_id, and no other FKs", async () => {
    const fks = await db.query<{ table: string; ref: string; def: string }>(
      `select c.conrelid::regclass::text as table, c.confrelid::regclass::text as ref, pg_get_constraintdef(c.oid) as def
       from pg_constraint c where c.contype = 'f'`,
    );
    const children = ALL_TABLES.filter((t) => !GLOBAL_TABLES.includes(t));
    for (const t of children) {
      const own = fks.filter((f) => f.table === t);
      expect(own, t).toHaveLength(1);
      expect(own[0].ref).toBe("trips");
      expect(own[0].def).toMatch(/FOREIGN KEY \(trip_id\) REFERENCES trips\(id\) ON DELETE CASCADE/);
    }
    const idx = await db.query<{ tablename: string; indexdef: string }>(
      "select tablename, indexdef from pg_indexes where schemaname = 'public'",
    );
    for (const t of children) {
      const has = idx.some((i) => i.tablename === t && /\(trip_id\)$/.test(i.indexdef));
      expect(has, `index on ${t}(trip_id)`).toBe(true);
    }
  });

  it("matches the row types column for column (names, types, nullability)", async () => {
    const cols = await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; udt_name: string }>(
      `select table_name, column_name, data_type, is_nullable, udt_name from information_schema.columns
       where table_schema = 'public' order by table_name, ordinal_position`,
    );
    const pgType: Record<string, string> = {
      uuid: "uuid",
      text: "text",
      int: "integer",
      float: "double precision",
      bool: "boolean",
      ts: "timestamp with time zone",
      jsonb: "jsonb",
      "int[]": "ARRAY",
    };
    const check = (table: string, spec: Record<string, ColDef>, extra: string[] = []) => {
      const actual = cols.filter((c) => c.table_name === table);
      expect(actual.map((c) => c.column_name).sort(), table).toEqual([...Object.keys(spec), ...extra].sort());
      for (const [name, def] of Object.entries(spec)) {
        const c = actual.find((x) => x.column_name === name)!;
        const nullable = typeof def === "object" ? !!def.nullable : def.endsWith("?");
        const base = typeof def === "object" ? "text" : def.replace("?", "");
        expect(c.data_type, `${table}.${name}`).toBe(pgType[base]);
        if (base === "int[]") expect(c.udt_name).toBe("_int4");
        expect(c.is_nullable, `${table}.${name} nullability`).toBe(nullable ? "YES" : "NO");
      }
    };
    check("trips", TRIP_SPEC as unknown as Record<string, ColDef>, ["commissioner_pin_hash"]);
    for (const t of ROW_TABLES) check(t, ROW_SPECS[t].columns as unknown as Record<string, ColDef>);
  });
});

describe("normalization", () => {
  it("returns ISO timestamps, parsed jsonb, number arrays and plain numbers", async () => {
    const [row] = await db.query(
      `select '2026-10-24T16:50:00.123Z'::timestamptz as ts, null::timestamptz as nts,
              '{"a":[1,{"b":null}],"s":"x"}'::jsonb as j, '[1,2]'::jsonb as ja, array[3,1,2]::int[] as arr,
              '{}'::int[] as empty, 1.25::double precision as d, 7::integer as i, count(*) as n,
              9007199254740993::bigint as huge, true as b, 'it''s'::text as s`,
    );
    expect(row).toEqual({
      ts: "2026-10-24T16:50:00.123Z",
      nts: null,
      j: { a: [1, { b: null }], s: "x" },
      ja: [1, 2],
      arr: [3, 1, 2],
      empty: [],
      d: 1.25,
      i: 7,
      n: 1,
      huge: "9007199254740993",
      b: true,
      s: "it's",
    });
  });

  it("accepts Dates, undefined, objects and raw JSON text as params", async () => {
    const [row] = await db.query(
      "select $1::timestamptz as t, $2::text as u, $3::jsonb as o, $4::jsonb as raw, $5::int[] as a",
      [new Date("2026-10-24T16:50:00.007Z"), undefined, { k: [1, "two"] }, '{"r":true}', [5, 6]],
    );
    expect(row).toEqual({ t: "2026-10-24T16:50:00.007Z", u: null, o: { k: [1, "two"] }, raw: { r: true }, a: [5, 6] });
  });

  it("cleans NUL and lone surrogates from string params, including inside objects", async () => {
    expect(cleanString("a\u0000b")).toBe("ab");
    expect(cleanString("x\ud83c")).toBe("x\ufffd");
    expect(cleanString("🍺 ok")).toBe("🍺 ok");
    const [row] = await db.query("select $1::text as t, $2::jsonb as j", ["nul\u0000 \ud83c", { k: ["\udc00", { n: "a\u0000" }] }]);
    expect(row).toEqual({ t: "nul \ufffd", j: { k: ["\ufffd", { n: "a" }] } });
  });

  it("normalizeValue/normalizeRow handle the driver types", () => {
    expect(normalizeValue(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(normalizeValue(new Date("nope"))).toBeNull();
    expect(normalizeValue(BigInt(5))).toBe(5);
    expect(normalizeValue([new Date(0)])).toEqual(["1970-01-01T00:00:00.000Z"]);
    expect(normalizeRow({ a: 1, b: null, c: { d: 1 } })).toEqual({ a: 1, b: null, c: { d: 1 } });
  });
});

describe("transactions", () => {
  beforeAll(async () => {
    await db.exec("create table tx_probe (id integer primary key, v text)");
  });

  it("commits and rolls back", async () => {
    await db.tx(async (t) => {
      await t.query("insert into tx_probe values (1, 'a')");
    });
    await expect(
      db.tx(async (t) => {
        await t.query("insert into tx_probe values (2, 'b')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await db.query("select id from tx_probe order by id");
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("nests with savepoints: an inner failure keeps the outer work", async () => {
    await db.tx(async (t) => {
      await t.query("insert into tx_probe values (10, 'outer')");
      await expect(
        t.tx(async (inner) => {
          await inner.query("insert into tx_probe values (11, 'inner')");
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
      await t.tx(async (inner) => {
        await inner.query("insert into tx_probe values (12, 'inner ok')");
      });
    });
    const rows = await db.query<{ id: number }>("select id from tx_probe where id >= 10 order by id");
    expect(rows.map((r) => r.id)).toEqual([10, 12]);
  });

  it("supports isolation / read-only options", async () => {
    const n = await db.tx(async (t) => (await t.query<{ n: number }>("select count(*) as n from tx_probe"))[0].n, {
      isolation: "repeatable read",
      readOnly: true,
    });
    expect(n).toBeGreaterThan(0);
    await expect(
      db.tx((t) => t.query("insert into tx_probe values (99, 'x')"), { readOnly: true }),
    ).rejects.toThrow();
  });

  it("refuses a tx handle used after the transaction ended", async () => {
    let leaked: { query: (s: string) => Promise<unknown> } | null = null;
    await db.tx(async (t) => {
      leaked = t;
    });
    await expect(leaked!.query("select 1")).rejects.toThrow(/already finished/);
  });

  it("serializes concurrent transactions on PGlite", async () => {
    await db.exec("create table counter (id integer primary key, n integer not null); insert into counter values (1, 0)");
    await Promise.all(
      Array.from({ length: 10 }, () =>
        db.tx(async (t) => {
          const [{ n }] = await t.query<{ n: number }>("select n from counter where id = 1");
          await t.query("update counter set n = $1 where id = 1", [n + 1]);
        }),
      ),
    );
    const [{ n }] = await db.query<{ n: number }>("select n from counter where id = 1");
    expect(n).toBe(10);
  });
});

describe("getDb", () => {
  it("routes to the test override", async () => {
    setDbForTests(db);
    const rows = await getDb().query<{ x: number }>("select 41 + 1 as x");
    expect(rows).toEqual([{ x: 42 }]);
    const viaTx = await getDb().tx(async (t) => (await t.query<{ x: number }>("select 1 as x"))[0].x);
    expect(viaTx).toBe(1);
    setDbForTests(null);
  });
});
