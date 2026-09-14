#!/usr/bin/env node
// Accounts and roles. Runs where the database is (laptop or VM). Passwords are hashed before they are stored.
//   npm run users -- list
//   npm run users -- add priya@procol.in engineer "Priya S"      -> prints a generated password once
//   npm run users -- add priya@procol.in engineer "Priya S" --password 'chosen-password'
//   npm run users -- role priya@procol.in qa                       (takes effect on her next request)
//   npm run users -- password priya@procol.in                      -> new generated password, old sessions kept
//   npm run users -- disable priya@procol.in | enable priya@procol.in
//   npm run users -- seed-demo [--password 'same-for-all']          -> one demo account per role
//   npm run users -- sessions
import { randomBytes } from "node:crypto";
import { q, one, pool } from "./db.mjs";
import { ROLES, DEFAULT_ROLE } from "./service/policy.mjs";
import { hashPassword } from "./service/auth.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const args = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [cmd, a, b, c] = args;
const who = process.env.USER || "cli";
const DOMAIN = (process.env.CKG_ALLOWED_DOMAIN || "procol.in").toLowerCase();
const genPassword = () => randomBytes(9).toString("base64url").replace(/[-_]/g, "x").slice(0, 12);

const upsert = async (email, role, name, password) => {
  const e = email.toLowerCase();
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  if (!e.endsWith(`@${DOMAIN}`)) console.warn(`  note: ${e} is not a ${DOMAIN} address`);
  await q(`insert into ckg.users (email, role, name, password_hash, set_by, disabled)
           values ($1,$2,$3,$4,$5,false)
           on conflict (email) do update set role = excluded.role, name = coalesce(excluded.name, ckg.users.name),
             password_hash = coalesce(excluded.password_hash, ckg.users.password_hash), set_by = excluded.set_by, set_at = now(), disabled = false`,
          [e, role, name || null, password ? hashPassword(password) : null, who]);
};

try {
  if (cmd === "list") {
    const rows = await q(`select email, role, name, disabled, password_hash is not null as has_pw, last_login from ckg.users order by role, email`);
    if (!rows.length) console.log(`no accounts yet; run: npm run users -- seed-demo`);
    for (const r of rows) console.log(`${r.role.padEnd(9)} ${r.email.padEnd(32)} ${(r.name || "").padEnd(18)} ${r.disabled ? "DISABLED" : r.has_pw ? "ok" : "no password"}  ${r.last_login ? "last login " + r.last_login.toISOString().slice(0, 16) : "never signed in"}`);
  } else if (cmd === "add") {
    if (!a || !b) throw new Error("usage: add <email> <role> [name] [--password <pw>]");
    const pw = flag("password") || genPassword();
    await upsert(a, b, c, pw);
    console.log(`${a.toLowerCase()}  role=${b}\n  password: ${pw}\n  (shown once; change it with: npm run users -- password ${a.toLowerCase()})`);
  } else if (cmd === "role") {
    if (!a || !b) throw new Error("usage: role <email> <role>");
    if (!ROLES.includes(b)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
    const n = (await q(`update ckg.users set role = $2, set_by = $3, set_at = now() where email = $1 returning email`, [a.toLowerCase(), b, who])).length;
    console.log(n ? `${a.toLowerCase()} -> ${b} (applies to their next request; no re-login needed)` : "no such account; use add");
  } else if (cmd === "password") {
    if (!a) throw new Error("usage: password <email> [--password <pw>]");
    const pw = flag("password") || genPassword();
    const n = (await q(`update ckg.users set password_hash = $2, set_by = $3, set_at = now() where email = $1 returning email`, [a.toLowerCase(), hashPassword(pw), who])).length;
    console.log(n ? `${a.toLowerCase()}  new password: ${pw}` : "no such account; use add");
  } else if (cmd === "disable" || cmd === "enable") {
    if (!a) throw new Error(`usage: ${cmd} <email>`);
    const n = (await q(`update ckg.users set disabled = $2 where email = $1 returning email`, [a.toLowerCase(), cmd === "disable"])).length;
    if (cmd === "disable") await q(`delete from ckg.sessions where email = $1`, [a.toLowerCase()]);
    console.log(n ? `${a.toLowerCase()} ${cmd}d${cmd === "disable" ? "; sessions ended" : ""}` : "no such account");
  } else if (cmd === "seed-demo") {
    const shared = flag("password");
    console.log(`demo accounts (${DOMAIN}):`);
    for (const r of ROLES) {
      const email = `${r}.demo@${DOMAIN}`, pw = shared || genPassword();
      await upsert(email, r, `${r[0].toUpperCase()}${r.slice(1)} demo`, pw);
      console.log(`  ${r.padEnd(9)} ${email.padEnd(28)} ${pw}`);
    }
    console.log("passwords are shown once; reset one with: npm run users -- password <email>");
  } else if (cmd === "sessions") {
    const rows = await q(`select email, role, via, created_at, last_seen from ckg.sessions where expires_at > now() order by last_seen desc limit 50`);
    for (const r of rows) console.log(`${r.email.padEnd(32)} ${(r.role || "").padEnd(9)} last seen ${r.last_seen.toISOString().slice(0, 16)}`);
    if (!rows.length) console.log("no active sessions");
  } else {
    console.log("commands: list | add <email> <role> [name] [--password pw] | role <email> <role> | password <email> [--password pw] | disable <email> | enable <email> | seed-demo [--password pw] | sessions");
    console.log(`roles: ${ROLES.join(", ")} (default ${DEFAULT_ROLE})`);
  }
} finally {
  await pool.end();
}
