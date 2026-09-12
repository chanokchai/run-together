import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

function valueFor(name) {
  const line = envExample.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  return line?.slice(name.length + 1) ?? null;
}

test('admin credentials are empty in the environment example', () => {
  for (const name of ['ADMIN_NAME', 'ADMIN_PIN', 'PIN_PEPPER']) {
    assert.equal(valueFor(name), '', `${name} must be explicitly supplied locally`);
  }
});
