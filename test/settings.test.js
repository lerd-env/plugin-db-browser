const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { readSettings, savePageSize } = require('../lib/settings');

const dir = path.join(__dirname, 'fixtures', 'data');

test('page size defaults to 100, is remembered, and refuses sizes not offered', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(readSettings(dir).pageSize, 100);
  savePageSize(dir, 250);
  assert.equal(readSettings(dir).pageSize, 250);
  assert.throws(() => savePageSize(dir, 7), /page size 7 is not one of 50, 100, 250, 500, 1000/);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
  assert.equal(readSettings(dir).pageSize, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});
