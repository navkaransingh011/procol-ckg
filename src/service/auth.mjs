// Identity and sessions. Email + password, checked against ckg.users (scrypt hashes, Node built-in, no
// dependency). A session is a random token the browser keeps in an HttpOnly cookie; the database keeps
// only its hash. The role is read from ckg.users on every request, so a role change applies at once.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { q, one } from "../db.mjs";
import { policyFor, DEFAULT_ROLE, ROLES } from "./policy.mjs";

const ALLOWED_DOMAIN = (process.env.CKG_ALLOWED_DOMAIN || "procol.in").toLowerCase();
const SESSION_DAYS = Number(process.env.CKG_SESSION_DAYS || 14);
const COOKIE = "ckg_session";
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const sha = (t) => createHash("sha256").update(t).digest("hex");

// ---- passwords ----
export function hashPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) throw new Error("password must be at least 8 characters");
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export function verifyPassword(pw, stored) {
  if (typeof pw !== "string" || typeof stored !== "string") return false;
  const [algo, n, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const key = scryptSync(pw, Buffer.from(salt, "base64url"), SCRYPT.keylen, { ...SCRYPT, N: Number(n) || SCRYPT.N });
  const want = Buffer.from(hash, "base64url");
  return key.length === want.length && timingSafeEqual(key, want);
}

// ---- brute-force brake: 5 failures per email or address, then a 60 s wait ----
const fails = new Map();
const brake = (k) => { const f = fails.get(k); return f && f.n >= 5 && Date.now() - f.at < 60_000; };
const noteFail = (k) => { const f = fails.get(k) || { n: 0 }; fails.set(k, { n: f.n + 1, at: Date.now() }); };
const clearFail = (k) => fails.delete(k);

// ---- cookies ----
export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const secure = (req) => req.headers["x-forwarded-proto"] === "https" || process.env.CKG_COOKIE_SECURE === "1";
export const sessionCookie = (token, req) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? "; Secure" : ""}`;
export const clearCookie = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? "; Secure" : ""}`;

export function authConfig() {
  return { mode: "password", domain: ALLOWED_DOMAIN, roles: ROLES, default_role: DEFAULT_ROLE };
}

/** The role for an email: from ckg.users, else the configured default (the lowest). */
export async function roleFor(email) {
  const u = await one(`select role from ckg.users where email = $1 and not disabled`, [email.toLowerCase()]).catch(() => null);
  return u?.role && ROLES.includes(u.role) ? u.role : DEFAULT_ROLE;
}

/** Email + password -> the user row, or an error message that gives nothing away. */
export async function checkPassword({ email, password }, ip = "?") {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !password) throw Object.assign(new Error("enter your email and password"), { code: 400 });
  if (brake(e) || brake(ip)) throw Object.assign(new Error("too many attempts; wait a minute"), { code: 429 });
  const u = await one(`select email, name, role, password_hash, disabled from ckg.users where email = $1`, [e]).catch(() => null);
  const ok = u && !u.disabled && u.password_hash && verifyPassword(password, u.password_hash);
  if (!ok) { noteFail(e); noteFail(ip); throw Object.assign(new Error("wrong email or password"), { code: 401 }); }
  clearFail(e); clearFail(ip);
  q(`update ckg.users set last_login = now() where email = $1`, [e]).catch(() => {});
  return { email: u.email, name: u.name || u.email.split("@")[0], picture: null };
}

export async function createSession({ email, name, picture, via }, req) {
  const token = randomBytes(32).toString("base64url");
  const role = await roleFor(email);
  await q(`insert into ckg.sessions (token_hash, email, name, picture, role, via, expires_at)
           values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval)`,
          [sha(token), email.toLowerCase(), name || null, picture || null, role, via, String(SESSION_DAYS)]);
  return { cookie: sessionCookie(token, req), user: { email: email.toLowerCase(), name, picture, role, via, policy: policyFor(role) } };
}

/** The signed-in person for this request, or null. Disabled accounts lose their sessions immediately. */
export async function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = await one(`select s.email, s.name, s.picture, s.via from ckg.sessions s join ckg.users u on u.email = s.email
                        where s.token_hash = $1 and s.expires_at > now() and not u.disabled`, [sha(token)]).catch(() => null);
  if (!s) return null;
  q(`update ckg.sessions set last_seen = now() where token_hash = $1 and last_seen < now() - interval '5 minutes'`, [sha(token)]).catch(() => {});
  const role = await roleFor(s.email);
  return { ...s, role, policy: policyFor(role) };
}

export async function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await q(`delete from ckg.sessions where token_hash = $1`, [sha(token)]).catch(() => {});
}
