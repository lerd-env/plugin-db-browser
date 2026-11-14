const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.LERD_BIN = path.join(__dirname, 'fixtures', 'fake-lerd');
const { withEngine, tables } = require('../lib/db');

test('a MySQL site with no database set is refused, not shown as empty', () => {
  process.env.FAKE_NO_DB = '1';
  const conn = withEngine({ sitePath: __dirname, service: '', database: '', engine: '' });
  assert.equal(conn.engine, 'mysql');
  assert.throws(() => tables(conn), /no database/);
  delete process.env.FAKE_NO_DB;
});

test('a picked connection reaches db:shell as --service and --database', () => {
  const conn = withEngine({ sitePath: __dirname, service: 'postgres', database: 'blog', engine: 'postgres' });
  assert.deepStrictEqual(tables(conn), [{ schema: 'public', name: 'posts', view: false }]);
});
