// Password storage and cookie parsing are pure functions; they are checked without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, parseCookies } from "../src/service/auth.mjs";

test("passwords are stored as salted scrypt hashes and verify only against the right password", () => {
  const h = hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(h, hashPassword("correct horse battery"), "a fresh salt every time");
  assert.equal(verifyPassword("correct horse battery", h), true);
  assert.equal(verifyPassword("correct horse batterx", h), false);
  assert.equal(verifyPassword("", h), false);
  assert.equal(verifyPassword("anything", "not-a-hash"), false);
  assert.throws(() => hashPassword("short"), /at least 8/);
});

test("cookie header parsing", () => {
  assert.deepEqual(parseCookies("a=1; ckg_session=abc%3Ddef; x=y"), { a: "1", ckg_session: "abc=def", x: "y" });
  assert.deepEqual(parseCookies(undefined), {});
});
