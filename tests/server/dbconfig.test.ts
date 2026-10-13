// DATABASE_URL mistakes are explained in plain English (src/lib/server/db.ts): obviously broken
// strings are refused before connecting, rejected logins name the fix, and a rejected login is
// held briefly instead of retried on every request (Supabase's pooler locks a project out after a
// burst of failed logins). The login errors come from a fake Postgres server speaking the wire
// protocol, so they're the real postgres.js error objects.
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, databaseConnectProblem, databaseUrlProblem, setDbForTests } from "@/lib/server/db";
import { GET as stateRoute } from "@/app/api/t/[code]/state/route";

const POOLER = "postgresql://postgres.xwroyxjvewtpqijdmsdl:s3cretPassw0rd@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

describe("databaseUrlProblem", () => {
  it("accepts real connection strings", () => {
    expect(databaseUrlProblem(POOLER)).toBeNull();
    expect(databaseUrlProblem("postgres://postgres:pw@127.0.0.1:5432/postgres?sslmode=disable")).toBeNull();
    expect(databaseUrlProblem("postgresql://localhost/scramble")).toBeNull();
    // Encoded symbols are fine; so is a colon in the password.
    expect(databaseUrlProblem(POOLER.replace("s3cretPassw0rd", "a%40b%2Fc%3Fd"))).toBeNull();
    expect(databaseUrlProblem(POOLER.replace("s3cretPassw0rd", "pa:ss"))).toBeNull();
  });

  it("catches the [YOUR-PASSWORD] placeholder, with or without brackets, and a bracketed password", () => {
    for (const pw of ["[YOUR-PASSWORD]", "YOUR-PASSWORD", "your_password", "[hunter22]"]) {
      expect(databaseUrlProblem(POOLER.replace("s3cretPassw0rd", pw))).toMatch(/still has the \[YOUR-PASSWORD\] placeholder/);
    }
  });

  it("catches passwords whose symbols break the string, and things that aren't Postgres URLs", () => {
    for (const pw of ["p@ss", "pa/ss", "pa?ss", "pa#ss", "100%zz"]) {
      expect(databaseUrlProblem(POOLER.replace("s3cretPassw0rd", pw)), pw).toMatch(/isn't a valid connection string/);
    }
    for (const url of ["aws-0-us-east-1.pooler.supabase.com:6543", "mysql://u:p@h/db", "https://xwroyxjvewtpqijdmsdl.supabase.co"]) {
      expect(databaseUrlProblem(url), url).toMatch(/isn't a valid connection string/);
    }
  });

  it("never echoes the password or user name", () => {
    for (const pw of ["p@ss", "[YOUR-PASSWORD]x", "[hunter22]"]) {
      const m = databaseUrlProblem(POOLER.replace("s3cretPassw0rd", pw)) ?? "";
      expect(m).not.toContain("hunter22");
      expect(m).not.toContain("xwroyxjvewtpqijdmsdl");
    }
  });
});

// ---------------------------------------------------------------------------
// A fake Postgres that answers every login with one ErrorResponse.
// ---------------------------------------------------------------------------

interface FakePg {
  url: (password?: string) => string;
  connections: () => number;
  setError: (code: string, message: string) => void;
  close: () => Promise<void>;
}

function errorResponse(code: string, message: string): Buffer {
  const fields = Buffer.concat([
    ...[
      ["S", "FATAL"],
      ["V", "FATAL"],
      ["C", code],
      ["M", message],
    ].map(([k, v]) => Buffer.from(`${k}${v}\0`, "utf8")),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(5);
  head.write("E", 0);
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

async function fakePg(): Promise<FakePg> {
  let count = 0;
  let reply = errorResponse("28P01", 'password authentication failed for user "postgres"');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => socket.end(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: (password = "wrong-pw") => `postgresql://postgres.someproject:${password}@127.0.0.1:${port}/postgres`,
    connections: () => count,
    setError: (code, message) => {
      reply = errorResponse(code, message);
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The driver's real error for a login the fake server refuses. */
async function loginError(pg: FakePg): Promise<unknown> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(pg.url(), { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql.unsafe("select 1");
    throw new Error("expected the login to fail");
  } catch (e) {
    return e;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

describe("databaseConnectProblem", () => {
  let pg: FakePg;
  beforeAll(async () => {
    pg = await fakePg();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("explains each rejected login the Supabase pooler sends", async () => {
    const cases: Array<[string, string, RegExp, number]> = [
      ["28P01", 'password authentication failed for user "postgres"', /rejected the database password/, 30_000],
      ["XX000", "Tenant or user not found", /doesn't recognize the user name or host/, 30_000],
      ["XX000", "Circuit breaker open: Too many authentication errors", /temporarily refusing database logins/, 60_000],
      ["3D000", 'database "postgress" does not exist', /should end in \/postgres/, 30_000],
    ];
    for (const [code, message, expected, holdMs] of cases) {
      pg.setError(code, message);
      const e = await loginError(pg);
      expect((e as { code?: string }).code).toBe(code);
      const problem = databaseConnectProblem(e, pg.url());
      expect(problem?.message, message).toMatch(expected);
      expect(problem?.holdMs).toBe(holdMs);
      expect(problem?.message).not.toContain("wrong-pw");
      expect(problem?.message).not.toContain("someproject");
    }
  });

  it("explains unreachable hosts, pointing the direct db.<ref> host at the pooler", async () => {
    // A port nothing listens on: a real ECONNREFUSED from the driver.
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const { default: postgres } = await import("postgres");
    const sql = postgres(`postgresql://u:p@127.0.0.1:${closed}/postgres`, { max: 1, connect_timeout: 5 });
    const refused = await sql.unsafe("select 1").then(
      () => null,
      (e: unknown) => e,
    );
    await sql.end({ timeout: 1 }).catch(() => {});
    expect((refused as { code?: string }).code).toBe("ECONNREFUSED");
    expect(databaseConnectProblem(refused, `postgresql://u:p@127.0.0.1:${closed}/postgres`)?.message).toMatch(
      new RegExp(`Can't reach the database at 127\\.0\\.0\\.1:${closed}.*paused`),
    );

    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    expect(databaseConnectProblem(notFound, POOLER.replace("aws-0", "aws-9"))?.message).toMatch(/host "aws-9-us-east-1.pooler.supabase.com" .* doesn't exist/);
    const direct = "postgresql://postgres:pw@db.xwroyxjvewtpqijdmsdl.supabase.co:5432/postgres";
    for (const code of ["ENOTFOUND", "ENETUNREACH", "CONNECT_TIMEOUT"]) {
      const e = Object.assign(new Error(code), { code });
      expect(databaseConnectProblem(e, direct)?.message, code).toMatch(/direct connection .* Transaction pooler/);
    }
  });

  it("leaves everything else alone (a generic 500 with the details in the logs)", () => {
    expect(databaseConnectProblem(Object.assign(new Error("relation x does not exist"), { code: "42P01" }), POOLER)).toBeNull();
    expect(databaseConnectProblem(new Error("boom"), POOLER)).toBeNull();
    expect(databaseConnectProblem(null, POOLER)).toBeNull();
  });
});

describe("what the app answers", () => {
  let pg: FakePg;
  beforeAll(async () => {
    pg = await fakePg();
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    setDbForTests(null);
    await closeDb();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await closeDb();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const state = () =>
    stateRoute(new Request("http://localhost:3000/api/t/ZZZZZZ/state"), { params: Promise.resolve({ code: "ZZZZZZ" }) });

  it("a wrong password: a 500 that says so, and the login is held for 30 s instead of retried on every request", async () => {
    pg.setError("28P01", 'password authentication failed for user "postgres"');
    vi.stubEnv("DATABASE_URL", pg.url());
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = pg.connections();

    const res = await state();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("not_configured");
    expect(body.error).toMatch(/rejected the database password in DATABASE_URL/);
    expect(JSON.stringify(body)).not.toContain("wrong-pw");
    expect(pg.connections()).toBe(before + 1);

    // Phones keep polling: no new login attempts while held.
    vi.advanceTimersByTime(29_000);
    for (let i = 0; i < 3; i++) expect((await (await state()).json()).code).toBe("not_configured");
    expect(pg.connections()).toBe(before + 1);

    // Then it tries again (the password may have been reset in Supabase to match).
    vi.advanceTimersByTime(2_000);
    expect((await (await state()).json()).code).toBe("not_configured");
    expect(pg.connections()).toBe(before + 2);

    // The log names the driver's error code for whoever reads the Vercel logs.
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^CONFIG ERROR: .*driver said: 28P01 password authentication failed/));
  });

  it("the placeholder is refused without ever connecting", async () => {
    vi.stubEnv("DATABASE_URL", pg.url("[YOUR-PASSWORD]"));
    const before = pg.connections();
    const body = (await (await state()).json()) as { error: string; code: string };
    expect(body).toMatchObject({ code: "not_configured" });
    expect(body.error).toMatch(/placeholder/);
    expect(pg.connections()).toBe(before);
  });

  it("an unexplained database error stays a generic 500 and is retried on the next request", async () => {
    pg.setError("53300", "sorry, too many clients already");
    vi.stubEnv("DATABASE_URL", pg.url());
    const before = pg.connections();
    const first = (await (await state()).json()) as { code: string };
    expect(first.code).toBe("server_error");
    await state();
    expect(pg.connections()).toBe(before + 2);
  });
});
