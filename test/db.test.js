const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.LERD_BIN = path.join(__dirname, 'fixtures', 'fake-lerd');
const { engineOf, tables } = require('../lib/db');

test('a MySQL site with no database set is refused, not shown as empty', () => {
  process.env.FAKE_NO_DB = '1';
  const site = __dirname;
  assert.equal(engineOf(site), 'mysql');
  assert.throws(() => tables(site, 'mysql'), /no database/);
});
