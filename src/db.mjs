import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.CKG_DATABASE_URL || "postgres://localhost/ckg",
  max: 8,
});

export async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

export async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] ?? null;
}

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

export const hex = (sha) => Buffer.from(sha, "hex");

export async function upsertRepo(owner, name, kind) {
  const r = await one(
    `insert into ckg.repos (owner, name, kind) values ($1,$2,$3)
     on conflict (owner, name) do update set kind = excluded.kind
     returning id`,
    [owner, name, kind],
  );
  return r.id;
}

export async function upsertCommit(repoId, sha, committedAt, subject, pkgVersion) {
  await q(
    `insert into ckg.commits (repo_id, sha, committed_at, subject, pkg_version)
     values ($1,$2,$3,$4,$5) on conflict (repo_id, sha) do nothing`,
    [repoId, hex(sha), committedAt, subject, pkgVersion],
  );
}

export async function touchRef(repoId, refName, sha, tenant, env) {
  await q(
    `insert into ckg.ref_history (repo_id, ref_name, commit_sha, tenant, env)
     values ($1,$2,$3,$4,$5)
     on conflict (repo_id, ref_name, commit_sha) do update set last_seen = now()`,
    [repoId, refName, hex(sha), tenant ?? null, env ?? null],
  );
}
