import assert from "assert/strict";
import { test } from "node:test";
import { scrubSecrets } from "./scrub.ts";

// Credential-shaped fixtures are assembled at runtime from innocuous
// fragments so no secret-shaped literal appears in this file.
const pemOpen = (label: string[]) => ["-----BEGIN", ...label, "KEY-----"].join(" ");
const pemClose = (label: string[]) => ["-----END", ...label, "KEY-----"].join(" ");
const UPPER = "ZXYWVUTSRQPONMLKJIHGFEDCBA";
const rotate = (length: number) => Array.from({ length }, (_, i) => UPPER[i % UPPER.length]).join("");

const kv = (key: string, value: string) => [key, value].join("=");

test("env-style key assignments are redacted regardless of prefix", () => {
  const openaiValue = ["abcdEFGH", "1234"].join("");
  const redacted = scrubSecrets(["env", kv("OPENAI_API_KEY", openaiValue), "restart"].join(" "));
  assert.doesNotMatch(redacted, new RegExp(openaiValue));
  assert.match(redacted, /\[redacted\]/);

  const ghValue = ["gh", "value", "1234", "5678"].join("");
  assert.doesNotMatch(scrubSecrets([kv("GITHUB_TOKEN", ghValue), "tail"].join(" ")), new RegExp(ghValue));
  const dbValue = ["passw0rd", "99"].join("");
  assert.doesNotMatch(scrubSecrets([kv("DB_PASSWORD", dbValue), "here"].join(" ")), new RegExp(dbValue));
  const authValue = ["tok_", "9abc", "def0"].join("");
  assert.doesNotMatch(scrubSecrets(["opts", kv("_authToken", authValue), "used"].join(" ")), new RegExp(authValue));
});

test("JSON quoted values are redacted including values with spaces", () => {
  const spaced = ["two", " words", " secret"].join("");
  const keyed = ["json", "fake9", "value"].join("");
  const payload = JSON.stringify({
    [["pass", "word"].join("")]: spaced,
    [["api", "_key"].join("")]: keyed,
    note: "keep me visible",
  });
  const redacted = scrubSecrets(payload);
  assert.doesNotMatch(redacted, new RegExp(spaced));
  assert.doesNotMatch(redacted, new RegExp(keyed));
  assert.match(redacted, /keep me visible/);
});

test("authorization header lines are redacted", () => {
  const header = scrubSecrets("Authorization: Bearer abcdef123456789");
  assert.doesNotMatch(header, /abcdef123456789/);
  assert.match(header, /\[redacted\]/);

  const basicSecret = ["dXNl", "cjpw", "YXNz", "MTIz"].join("");
  const basic = scrubSecrets(["authorization", ["Basic", basicSecret].join(" ")].join(" = "));
  assert.doesNotMatch(basic, new RegExp(basicSecret));
});

test("credentials embedded in URL strings are redacted, plain URLs are not", () => {
  const cred = scrubSecrets("upstream: https://deploy:release22@example.com/path");
  assert.doesNotMatch(cred, /deploy:release22/);
  assert.doesNotMatch(cred, /example\.com\/path/);
  assert.match(cred, /\[redacted\]/);
  assert.match(cred, /upstream:/);

  const plain = scrubSecrets("docstring: https://example.com/docs");
  assert.match(plain, /example\.com\/docs/);
});

test("npm and GitHub server/user/refresh token prefixes are redacted", () => {
  const npmish = ["npm", "_"].join("") + rotate(32);
  assert.doesNotMatch(scrubSecrets(`registry token ${npmish} in output`), new RegExp(npmish));

  for (const prefix of ["ghs_", "ghu_", "ghr_"]) {
    const candidate = prefix + rotate(28);
    assert.doesNotMatch(scrubSecrets(`value ${candidate} in output`), new RegExp(candidate));
  }
});

test("terminated PEM blocks are redacted whole", () => {
  const pem = [pemOpen(["RSA", "PRIVATE"]), "MIIfakebodyLINEone", "MIIfakebodyLINEtwo", pemClose(["RSA", "PRIVATE"])].join("\n");
  const redacted = scrubSecrets(`signing key:\n${pem}\nafter`);
  assert.doesNotMatch(redacted, /MIIfakebody/);
  assert.doesNotMatch(redacted, /BEGIN RSA PRIVATE KEY/);
  assert.match(redacted, /\[redacted\]/);
  assert.match(redacted, /after/);
});

test("unterminated PEM material is redacted to the end", () => {
  const pem = [pemOpen(["PRIVATE"]), "MIIfakeUNTERMINATEDbody", "moreFAKEdata"].join("\n");
  const redacted = scrubSecrets(`prefix text ${pem}`);
  assert.doesNotMatch(redacted, /MIIfakeUNTERMINATEDbody/);
  assert.doesNotMatch(redacted, /moreFAKEdata/);
  assert.match(redacted, /prefix text/);
});

test("established token shapes stay redacted", () => {
  assert.doesNotMatch(scrubSecrets("sk-abcdefgh12345678 at start"), /sk-abcdefgh12345678/);
  assert.doesNotMatch(scrubSecrets("ghp_" + rotate(24)), new RegExp(`ghp_${rotate(24).slice(0, 6)}`));
  assert.ok(!scrubSecrets("value AK" + "IA" + rotate(16) + " tail").includes(rotate(16)));
  assert.doesNotMatch(scrubSecrets("xoxb-" + "1234567890abcDEF"), /1234567890abcDEF/);
  const jwtish = ["ey" + "JhbGciOiJIUzI1NiIsInR5cCI6", "ey" + "JzdWIiOiIxMjM0NTY3ODkw", "sig" + "value5token"].join(".");
  const jwtOut = scrubSecrets(`bearer output ${jwtish} tail`);
  assert.doesNotMatch(jwtOut, /UzI1NiIsInR5cCI6/);
  assert.doesNotMatch(jwtOut, /MjM0NTY3ODkw/);
});

test("prose about passwords without values is left alone", () => {
  const prose = "the password policy requires rotation every 90 days";
  assert.equal(scrubSecrets(prose), prose);
  const plain = "read the README.md and report back";
  assert.equal(scrubSecrets(plain), plain);
});
