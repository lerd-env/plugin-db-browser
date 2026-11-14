const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const API = path.join(__dirname, '..', 'bin', 'api');
const DATA = path.join(__dirname, 'fixtures', 'api-data');

// One call of the endpoint the way lerd makes it: the body on stdin, the site
// and the plugin's data folder in the environment.
function call(body, env = {}) {
  const r = spawnSync(API, {
    input: JSON.stringify(body),
    encoding: 'utf8',
    env: { ...process.env, LERD_BIN: path.join(__dirname, 'fixtures', 'fake-lerd'), LERD_SITE_PATH: __dirname, LERD_PLUGIN_DATA: DATA, ...env },
  });
  return { status: r.status, json: r.status === 0 ? JSON.parse(r.stdout) : null, error: r.stderr.trim() };
}

test.beforeEach(() => fs.rmSync(DATA, { recursive: true, force: true }));
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('tables lists tables and views with the remembered page size', () => {
  const { json } = call({ action: 'tables' });
  assert.equal(json.engine, 'mysql');
  assert.deepStrictEqual(json.tables, [{ schema: '', name: 'users', view: false }, { schema: '', name: 'active_users', view: true }]);
  assert.equal(json.pageSize, 100);
  assert.deepStrictEqual(json.pageSizes, [50, 100, 250, 500, 1000]);
});

test('rows answers a page with the total, nulls as null and values unescaped', () => {
  const { json } = call({ action: 'rows', table: 'users', offset: 1 });
  assert.deepStrictEqual(json.columns, ['id', 'name']);
  assert.deepStrictEqual(json.rows, [['2', null], ['3', 'tab\there']]);
  assert.equal(json.total, 3);
  assert.equal(json.offset, 1);
  assert.equal(json.limit, 100);
});

test('rows uses the page size saved with page_size', () => {
  assert.equal(call({ action: 'page_size', size: 50 }).json.pageSize, 50);
  assert.equal(call({ action: 'rows', table: 'users' }).json.limit, 50);
  assert.equal(call({ action: 'tables' }).json.pageSize, 50);
});

test('a negative or junk offset reads from the start', () => {
  assert.equal(call({ action: 'rows', table: 'users', offset: -5 }).json.offset, 0);
  assert.equal(call({ action: 'rows', table: 'users', offset: 'x' }).json.offset, 0);
});

test('a table that is not in the list never reaches the SQL', () => {
  const r = call({ action: 'rows', table: 'users`; DROP TABLE users; --' });
  assert.equal(r.status, 1);
  assert.match(r.error, /no table users`; DROP TABLE users; -- in this database/);
});

test('bad requests are refused by name', () => {
  assert.match(call({ action: 'page_size', size: 7 }).error, /page size 7 is not one of/);
  assert.match(call({ action: 'explode' }).error, /unknown action explode/);
  assert.match(call({ action: 'tables' }, { LERD_SITE_PATH: '' }).error, /pick a site/);
  assert.match(call({ action: 'tables' }, { FAKE_NO_DB: '1' }).error, /names no database/);
});
