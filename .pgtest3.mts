import { PGlite } from "@electric-sql/pglite";
for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  const db = await PGlite.create("memory://");
  await db.query("select 1");
  console.log("create", i, Date.now() - t0);
  if (i === 2) {
    const t1 = Date.now();
    const c = await db.clone();
    await c.query("select 1");
    console.log("clone", Date.now() - t1);
  }
}
