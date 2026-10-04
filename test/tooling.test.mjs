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
