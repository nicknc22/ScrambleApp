// DATABASE_URL mistakes are explained in plain English (src/lib/server/db.ts): obviously broken
// strings are refused before connecting, rejected logins name the fix, and a rejected login is
// held briefly instead of retried on every request (Supabase's pooler locks a project out after a
// burst of failed logins). The login errors come from a fake Postgres server speaking the wire
// protocol, so they're the real postgres.js error objects; the texts are Supavisor's (current
// "(ECODE) text" form and the older wording).
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, databaseConnectProblem, databaseUrlProblem, setDbForTests, setDbOpenDeadlineForTests } from "@/lib/server/db";
import { GET as stateRoute } from "@/app/api/t/[code]/state/route";

const POOLER = "postgresql://postgres.xwroyxjvewtpqijdmsdl:s3cretPassw0rd@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const withPassword = (pw: string) => POOLER.replace("s3cretPassw0rd", pw);

describe("databaseUrlProblem", () => {
  it("accepts real connection strings", () => {
    const ok = [
      POOLER,
      "postgres://postgres:pw@127.0.0.1:5432/postgres?sslmode=disable",
      "postgresql://localhost/scramble",
      POOLER + "?sslmode=require&pgbouncer=true",
      POOLER + "?application_name=a@b",
      "postgresql://postgres:pw@db.xwroyxjvewtpqijdmsdl.supabase.co:5432/postgres",
      // Encoded symbols, a colon, a raw "@" (the host is what follows the LAST "@"), brackets
      // inside, and a password that merely contains the word.
      withPassword("a%40b%2Fc%3Fd%23e%25f"),
      withPassword("pa:ss"),
      withPassword("p@ss"),
      withPassword("p@ss@word"),
      withPassword("[hunter22]"),
      withPassword("NotYourPassword9"),
    ];
    for (const url of ok) expect(databaseUrlProblem(url), url).toBeNull();
  });

  it("catches the [YOUR-PASSWORD] placeholder, with or without brackets", () => {
    for (const pw of ["[YOUR-PASSWORD]", "YOUR-PASSWORD", "your_password", "%5BYOUR-PASSWORD%5D"]) {
      expect(databaseUrlProblem(withPassword(pw)), pw).toMatch(/still has the \[YOUR-PASSWORD\] placeholder/);
    }
  });

  it("catches passwords whose symbols break the string, and things that aren't Postgres URLs", () => {
    for (const pw of ["pa/ss", "1234/x", "pa?ss", "pa#ss", "1234#abc", "100%zz", "a@b,c"]) {
      expect(databaseUrlProblem(withPassword(pw)), pw).toMatch(/isn't a valid connection string/);
    }
    for (const url of ["aws-0-us-east-1.pooler.supabase.com:6543", "mysql://u:p@h/db", "https://xwroyxjvewtpqijdmsdl.supabase.co"]) {
      expect(databaseUrlProblem(url), url).toMatch(/isn't a valid connection string/);
    }
  });

  it("never echoes the password or user name", () => {
    for (const pw of ["pa/ss9hunter", "[YOUR-PASSWORD]", "1234#hunter22"]) {
      const m = databaseUrlProblem(withPassword(pw)) ?? "";
      expect(m).not.toContain("hunter");
      expect(m).not.toContain("xwroyxjvewtpqijdmsdl");
    }
  });
});

// ---------------------------------------------------------------------------
// A fake Postgres that answers each login with a scripted ErrorResponse (or hangs up).
// ---------------------------------------------------------------------------

interface Reply {
  code: string;
  message: string;
  severity?: string;
  hint?: string;
}

interface FakePg {
  url: (password?: string) => string;
  connections: () => number;
  /** Replies for the next logins, in order; the last one repeats. "hangup" closes without a word. */
  script: (...replies: Array<Reply | "hangup">) => void;
  close: () => Promise<void>;
}

function errorResponse(r: Reply): Buffer {
  const fields: Array<[string, string]> = [
    ["S", r.severity ?? "FATAL"],
    ["V", r.severity ?? "FATAL"],
    ["C", r.code],
    ["M", r.message],
  ];
  if (r.hint) fields.push(["H", r.hint]);
  const body = Buffer.concat([...fields.map(([k, v]) => Buffer.from(`${k}${v}\0`, "utf8")), Buffer.from([0])]);
  const head = Buffer.alloc(5);
  head.write("E", 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const WRONG_PASSWORD: Reply = { code: "28P01", message: 'password authentication failed for user "postgres"' };

async function fakePg(): Promise<FakePg> {
  let count = 0;
  let replies: Array<Reply | "hangup"> = [WRONG_PASSWORD];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    const reply = replies[Math.min(count, replies.length - 1)];
    count++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => (reply === "hangup" ? socket.destroy() : socket.end(errorResponse(reply))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: (password = "wrong-pw") => `postgresql://postgres.someproject:${password}@127.0.0.1:${port}/postgres`,
    connections: () => count,
    script: (...r) => {
      replies = r;
      count = 0;
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

const PAUSED = /probably paused or restarting/;
const LOCKOUT = /temporarily refusing database logins/;
const TENANT = /doesn't recognize the user name or host/;

describe("databaseConnectProblem", () => {
  let pg: FakePg;
  beforeAll(async () => {
    pg = await fakePg();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("explains each rejected login the Supabase pooler sends", async () => {
    const cases: Array<[Reply, RegExp, number]> = [
      [WRONG_PASSWORD, /rejected the database password/, 30_000],
      // Supavisor ≥ 2.9: "(ECODE) text", SQLSTATE XX000.
      [{ code: "XX000", message: "(ENOTFOUND) tenant/user postgres.someproject not found" }, TENANT, 30_000],
      [{ code: "XX000", message: "(ENOIDENTIFIER) no tenant identifier provided (external_id or sni_hostname required)" }, TENANT, 30_000],
      [{ code: "XX000", message: "(ECIRCUITBREAKER) too many authentication failures, new connections are temporarily blocked" }, LOCKOUT, 60_000],
      [{ code: "XX000", message: "(ECIRCUITBREAKER) failed to retrieve database credentials after multiple attempts, new connections are temporarily blocked" }, PAUSED, 10_000],
      [{ code: "XX000", message: "(ECIRCUITBREAKER) too many failed attempts to connect to the database, new connections are temporarily blocked" }, PAUSED, 10_000],
      [{ code: "XX000", message: "(EAUTHQUERY) auth_query connection failed: connection refused" }, PAUSED, 10_000],
      [{ code: "XX000", message: "(EAUTHSECRETS) failed to retrieve authentication secrets: timeout" }, PAUSED, 10_000],
      [{ code: "08006", message: "Failed to connect to database: econnrefused" }, PAUSED, 10_000],
      [{ code: "57P03", message: "the database system is starting up" }, PAUSED, 10_000],
      [{ code: "XX000", message: "(EADDRNOTALLOWED) address not in tenant allow_list: 3.80.1.2" }, /Network Restrictions/, 30_000],
      // The older wording.
      [{ code: "XX000", message: "Tenant or user not found" }, TENANT, 30_000],
      [{ code: "XX000", message: "Circuit breaker open: Too many authentication errors" }, LOCKOUT, 60_000],
      [{ code: "XX000", message: "Circuit breaker open: Unable to establish connection to upstream database" }, PAUSED, 10_000],
      [{ code: "3D000", message: 'database "postgress" does not exist' }, /should end in \/postgres/, 30_000],
      // Right after a password change: a one-off refusal of the RIGHT password.
      [{ ...WRONG_PASSWORD, hint: "The password for this user was recently changed. Retry the connection." }, /still picking up your new database password/, 0],
      // Anything else refused at login: its own words, minus the user and password.
      [{ code: "XX000", message: "(EMAXCONN) max client connections reached, limit: 200" }, /refused the database connection: "\(EMAXCONN\) max client connections reached, limit: 200"/, 10_000],
      [{ code: "XX000", message: "(EBANNED) tenant is banned: postgres.someproject wrong-pw" }, /"\(EBANNED\) tenant is banned: … …"/, 10_000],
    ];
    for (const [reply, expected, holdMs] of cases) {
      pg.script(reply);
      const e = await loginError(pg);
      expect((e as { code?: string }).code).toBe(reply.code);
      const problem = databaseConnectProblem(e, pg.url());
      expect(problem?.message, reply.message).toMatch(expected);
      expect(problem?.holdMs, reply.message).toBe(holdMs);
      expect(problem?.message).not.toContain("wrong-pw");
      expect(problem?.message).not.toContain("someproject");
    }
  });

  it("treats postgres.js's own SCRAM failure (older poolers) as a wrong password", () => {
    const e = Object.assign(new Error("SASL_SIGNATURE_MISMATCH: The server did not return the correct signature"), { code: "SASL_SIGNATURE_MISMATCH" });
    expect(databaseConnectProblem(e, POOLER)?.message).toMatch(/rejected the database password/);
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
    expect(databaseConnectProblem(Object.assign(new Error("relation x does not exist"), { code: "42P01", severity: "ERROR" }), POOLER)).toBeNull();
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
    setDbOpenDeadlineForTests(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const state = () =>
    stateRoute(new Request("http://localhost:3000/api/t/ZZZZZZ/state"), { params: Promise.resolve({ code: "ZZZZZZ" }) });

  it("a wrong password: a 500 that says so, and the login is held for 30 s instead of retried on every request", async () => {
    pg.script(WRONG_PASSWORD);
    vi.stubEnv("DATABASE_URL", pg.url());
    vi.useFakeTimers({ toFake: ["Date"] });

    const res = await state();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("not_configured");
    expect(body.error).toMatch(/rejected the database password in DATABASE_URL/);
    expect(JSON.stringify(body)).not.toContain("wrong-pw");
    expect(pg.connections()).toBe(1);

    // Phones keep polling: no new login attempts while held.
    vi.advanceTimersByTime(29_000);
    for (let i = 0; i < 3; i++) expect((await (await state()).json()).code).toBe("not_configured");
    expect(pg.connections()).toBe(1);

    // Then it tries again (the password may have been reset in Supabase to match).
    vi.advanceTimersByTime(2_000);
    expect((await (await state()).json()).code).toBe("not_configured");
    expect(pg.connections()).toBe(2);

    // The log names the driver's error code for whoever reads the Vercel logs.
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^CONFIG ERROR: .*driver said: 28P01 password authentication failed/));
  });

  it("the placeholder is refused without ever connecting", async () => {
    pg.script(WRONG_PASSWORD);
    vi.stubEnv("DATABASE_URL", pg.url("[YOUR-PASSWORD]"));
    const body = (await (await state()).json()) as { error: string; code: string };
    expect(body).toMatchObject({ code: "not_configured" });
    expect(body.error).toMatch(/placeholder/);
    expect(pg.connections()).toBe(0);
  });

  it("the pooler's one-off 'password recently changed' refusal is retried at once", async () => {
    const changed = { ...WRONG_PASSWORD, hint: "The password for this user was recently changed. Retry the connection." };
    // Still refused on the retry: the second answer decides (here: really the wrong password).
    pg.script(changed, WRONG_PASSWORD);
    vi.stubEnv("DATABASE_URL", pg.url());
    expect((await (await state()).json()).error).toMatch(/rejected the database password/);
    expect(pg.connections()).toBe(2);

    // Refused twice as "recently changed": say so, and don't hold it.
    await closeDb();
    pg.script(changed);
    expect((await (await state()).json()).error).toMatch(/still picking up your new database password/);
    expect(pg.connections()).toBe(2);
    await state();
    expect(pg.connections()).toBe(4);
  });

  it("a server that hangs up without a word: a deadline instead of postgres.js reconnecting forever", async () => {
    pg.script("hangup");
    setDbOpenDeadlineForTests(400);
    vi.stubEnv("DATABASE_URL", pg.url());
    const body = (await (await state()).json()) as { error: string; code: string };
    expect(body.code).toBe("not_configured");
    expect(body.error).toMatch(/took the connection but never answered/);
    // The driver was shut down: no more connection attempts.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = pg.connections();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pg.connections()).toBe(after);
  });

  it("an unexplained database error stays a generic 500 and is retried on the next request", async () => {
    pg.script({ code: "42501", message: "permission denied for schema public", severity: "ERROR" });
    vi.stubEnv("DATABASE_URL", pg.url());
    const first = (await (await state()).json()) as { code: string };
    expect(first.code).toBe("server_error");
    await state();
    expect(pg.connections()).toBe(2);
  });
});
