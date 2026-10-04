import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("deployment never applies remote migrations through an implicit lifecycle hook", async () => {
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(scripts.predeploy, undefined);
  assert.equal(scripts.postdeploy, undefined);
  assert.equal(scripts["deploy:dev"], undefined, "a renamed Worker is not isolated storage");
  assert.equal(scripts["deploy:prod"], undefined, "a renamed Worker is not isolated storage");
  assert.match(scripts["migrate:remote"], /--remote/);
});

test("remote helper commands require the separately approved deployment configuration", async () => {
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
  for (const name of ["deploy", "migrate:remote", "db:create", "kv:create", "secrets:set", "secrets:list",
    "logs", "db:query", "db:tables", "db:users"]) {
    assert.match(scripts[name], /--config wrangler\.deploy\.json(?:\s|$)/, name);
  }
  for (const command of scripts["setup:secrets"].split("&&").filter((part) => part.includes("wrangler"))) {
    assert.match(command, /--config wrangler\.deploy\.json(?:\s|$)/);
  }
  assert.equal(scripts.dev, "wrangler dev --local");
  assert.doesNotMatch(scripts["migrate:local"], /--remote|wrangler\.deploy/);
  assert.doesNotMatch(scripts["bundle:test"], /wrangler\.deploy/);
});
