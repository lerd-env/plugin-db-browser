const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const API = path.join(__dirname, '..', 'bin', 'api');
const DATA = path.join(__dirname, 'fixtures', 'api-data');
const LOG = path.join(DATA, 'calls.log');
const TOKEN = 'test-token';

// lerd's own API as the plugin sees it: shop points at two databases, solo at
// one, and legacy is a lerd from before sites listed their databases.
const SITES = [
  { name: 'shop', has_database: true, databases: [{ service: 'mysql', database: 'shop' }, { service: 'postgres', database: 'blog' }] },
  { name: 'solo', has_database: true, databases: [{ service: 'mariadb-app', database: 'legacy' }] },
  { name: 'legacy' },
];
const SERVICES = [{ service: 'mysql', family: 'mysql' }, { service: 'mariadb-app', family: 'mariadb' }, { service: 'postgres', family: 'postgres' }];

let server, url;
let hits = {};
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers['x-lerd-plugin-token'] !== TOKEN) return res.writeHead(401).end('no token');
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    const body = { '/api/sites': SITES, '/api/databases': SERVICES }[req.url];
    if (!body) return res.writeHead(404).end();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});
test.beforeEach(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
});

// One call of the endpoint the way lerd makes it: the body on stdin, the site
// and the plugin's data folder in the environment. Async, so the stub API above
// can answer while the endpoint runs.
function call(body, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(API, {
      env: {
        ...process.env, LERD_BIN: path.join(__dirname, 'fixtures', 'fake-lerd'), LERD_SITE: 'shop', LERD_SITE_PATH: __dirname,
        LERD_PLUGIN_DATA: DATA, LERD_API_URL: url, LERD_API_TOKEN: TOKEN, FAKE_LOG: LOG, ...env,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (status) => resolve({ status, json: status === 0 ? JSON.parse(out) : null, error: err.trim() }));
    child.stdin.end(JSON.stringify(body));
  });
}

test('tables opens the site\'s first database and lists the others it may switch to', async () => {
  const { json } = await call({ action: 'tables' });
  assert.equal(json.engine, 'mysql');
  assert.equal(json.database, 'shop');
  assert.deepStrictEqual(json.connection, { service: 'mysql', database: 'shop', engine: 'mysql' });
  assert.deepStrictEqual(json.connections.map((c) => `${c.service}/${c.database}`), ['mysql/shop', 'postgres/blog']);
  assert.deepStrictEqual(json.tables, [{ schema: '', name: 'users', view: false }, { schema: '', name: 'active_users', view: true }]);
  assert.equal(json.pageSize, 100);
  assert.deepStrictEqual(json.pageSizes, [50, 100, 250, 500, 1000]);
});

test('picking another of the site\'s databases opens it and is remembered', async () => {
  const picked = await call({ action: 'tables', service: 'postgres', database: 'blog' });
  assert.equal(picked.json.engine, 'postgres');
  assert.deepStrictEqual(picked.json.tables, [{ schema: 'public', name: 'posts', view: false }]);
  assert.match(fs.readFileSync(LOG, 'utf8'), /db:shell --service=postgres --database=blog/);

  const again = await call({ action: 'tables' });
  assert.equal(again.json.database, 'blog');
  const rows = await call({ action: 'rows', table: 'posts', schema: 'public' });
  assert.deepStrictEqual(rows.json.rows, [['1', 'Hello']]);
});

test('a database that is not the site\'s is refused before anything runs', async () => {
  const r = await call({ action: 'tables', service: 'mysql', database: 'other_site' });
  assert.equal(r.status, 1);
  assert.match(r.error, /mysql \/ other_site is not one of this site's databases/);
  assert.equal(fs.existsSync(LOG), false);
});

test('a remembered database the site no longer points at falls back with a notice', async () => {
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ connections: { shop: { service: 'mysql', database: 'dropped' } } }));
  const { json } = await call({ action: 'tables' });
  assert.equal(json.database, 'shop');
  assert.equal(json.notice, "mysql / dropped is no longer one of this site's databases, showing mysql / shop");
});

test('a lerd that lists no databases uses the site default, which db:shell resolves', async () => {
  const { json } = await call({ action: 'tables' }, { LERD_SITE: 'legacy' });
  assert.deepStrictEqual(json.connection, { service: '', database: '', engine: 'mysql' });
  assert.equal(json.database, 'shop');
  assert.match(fs.readFileSync(LOG, 'utf8'), /^db:shell$/m);
});

test('rows answers a page with the total, nulls as null and values unescaped', async () => {
  const { json } = await call({ action: 'rows', table: 'users', offset: 1 });
  assert.deepStrictEqual(json.columns, ['id', 'name']);
  assert.deepStrictEqual(json.rows, [['2', null], ['3', 'tab\there']]);
  assert.equal(json.total, 3);
  assert.equal(json.offset, 1);
  assert.equal(json.limit, 100);
});

test('rows uses the page size saved with page_size', async () => {
  assert.equal((await call({ action: 'page_size', size: 50 })).json.pageSize, 50);
  assert.equal((await call({ action: 'rows', table: 'users' })).json.limit, 50);
  assert.equal((await call({ action: 'tables' })).json.pageSize, 50);
});

test('a negative or junk offset reads from the start', async () => {
  assert.equal((await call({ action: 'rows', table: 'users', offset: -5 })).json.offset, 0);
  assert.equal((await call({ action: 'rows', table: 'users', offset: 'x' })).json.offset, 0);
});

test('a table that is not in the list never reaches the SQL', async () => {
  const r = await call({ action: 'rows', table: 'users`; DROP TABLE users; --' });
  assert.equal(r.status, 1);
  assert.match(r.error, /no table users`; DROP TABLE users; -- in this database/);
});

test('bad requests are refused by name', async () => {
  assert.match((await call({ action: 'page_size', size: 7 })).error, /page size 7 is not one of/);
  assert.match((await call({ action: 'explode' })).error, /unknown action explode/);
  assert.match((await call({ action: 'tables' }, { LERD_SITE_PATH: '' })).error, /pick a site/);
  assert.match((await call({ action: 'tables' }, { LERD_SITE: 'nowhere' })).error, /lerd lists no site nowhere/);
  assert.match((await call({ action: 'tables' }, { LERD_SITE: 'legacy', FAKE_NO_DB: '1' })).error, /names no database/);
  assert.match((await call({ action: 'tables' }, { LERD_API_TOKEN: 'wrong' })).error, /lerd API \/api\/(sites|databases): 401/);
});

test('rows sorts by a column, and otherwise by the primary key it reports', async () => {
  const byKey = await call({ action: 'rows', table: 'users' });
  assert.deepStrictEqual(byKey.json.keys, ['id']);
  assert.match(fs.readFileSync(LOG, 'utf8'), /db:shell/);
  const desc = await call({ action: 'rows', table: 'users', sort: { column: 'id', dir: 'desc' } });
  assert.deepStrictEqual(desc.json.rows.map((r) => r[0]), ['3', '2', '1']);
});

test('rows filters, counts what matches, and keeps the columns when nothing does', async () => {
  const hit = await call({ action: 'rows', table: 'users', filter: { column: 'name', op: 'starts with', value: 'an' } });
  assert.deepStrictEqual(hit.json.rows, [['1', 'ana']]);
  assert.equal(hit.json.total, 1);
  const none = await call({ action: 'rows', table: 'users', filter: { column: 'name', op: '=', value: 'nobody' } });
  assert.deepStrictEqual(none.json.rows, []);
  assert.deepStrictEqual(none.json.columns, ['id', 'name']);
  assert.equal(none.json.total, 0);
});

test('a sort or filter on a column the table does not have is refused', async () => {
  assert.match((await call({ action: 'rows', table: 'users', sort: { column: 'password', dir: 'asc' } })).error, /no column password in users/);
  assert.match((await call({ action: 'rows', table: 'users', filter: { column: 'name', op: 'OR', value: '1' } })).error, /filter operator OR is not one of/);
});

test('structure answers columns, indexes and foreign keys', async () => {
  const { json } = await call({ action: 'structure', table: 'posts', schema: 'public', service: 'postgres', database: 'blog' });
  assert.deepStrictEqual(json.columns, [
    { name: 'id', type: 'integer', nullable: false, default: '', key: true },
    { name: 'title', type: 'text', nullable: true, default: '', key: false },
  ]);
  assert.deepStrictEqual(json.indexes, [{ name: 'posts_pkey', definition: 'CREATE UNIQUE INDEX posts_pkey ON public.posts USING btree (id)' }]);
  assert.deepStrictEqual(json.foreignKeys, [{ name: 'posts_user_fk', definition: 'FOREIGN KEY (user_id) REFERENCES users(id)' }]);
  assert.match((await call({ action: 'structure', table: 'nope' })).error, /no table nope/);
});

test('tables lists the filter operators the UI may offer', async () => {
  const { json } = await call({ action: 'tables' });
  assert.deepStrictEqual(json.operators, ['=', '!=', '<', '>', '<=', '>=', 'contains', 'starts with', 'is null', 'is not null']);
});

const logged = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');

test('a read runs at once, says how long it took, and goes into the site\'s history', async () => {
  const { json } = await call({ action: 'query', sql: 'SELECT n FROM numbers LIMIT 3;' });
  assert.deepStrictEqual(json.columns, ['n']);
  assert.deepStrictEqual(json.rows, [['1'], ['2'], ['3']]);
  assert.equal(json.read, true);
  assert.equal(json.truncated, false);
  assert.equal(typeof json.ms, 'number');
  assert.deepStrictEqual((await call({ action: 'history' })).json.history, ['SELECT n FROM numbers LIMIT 3']);
});

test('a read with no LIMIT of its own stops at 1000 rows and says it was cut', async () => {
  const { json } = await call({ action: 'query', sql: 'SELECT n FROM numbers' });
  assert.equal(json.rows.length, 1000);
  assert.equal(json.truncated, true);
  assert.equal(json.cap, 1000);
  assert.match(logged(), /SELECT n FROM numbers LIMIT 1001/);
});

test('a write is not run until confirmed, then reports the rows it changed', async () => {
  const ask = await call({ action: 'query', sql: "UPDATE users SET name = 'x'" });
  assert.equal(ask.json.confirm, 'This statement can change shop. Run it?');
  assert.equal(ask.json.rows, undefined);
  assert.doesNotMatch(logged(), /UPDATE/);
  assert.deepStrictEqual((await call({ action: 'history' })).json.history, []);

  const done = await call({ action: 'query', sql: "UPDATE users SET name = 'x'", confirm: true });
  assert.equal(done.json.read, false);
  assert.equal(done.json.affected, 2);
  assert.deepStrictEqual((await call({ action: 'history' })).json.history, ["UPDATE users SET name = 'x'"]);
});

test('a write on PostgreSQL reads its row count from the command tag', async () => {
  const { json } = await call({ action: 'query', sql: "UPDATE posts SET title = 'x'", confirm: true, service: 'postgres', database: 'blog' });
  assert.equal(json.affected, 1);
  assert.deepStrictEqual(json.rows, []);
});

test('two statements, or nothing to run, are refused before anything runs', async () => {
  assert.match((await call({ action: 'query', sql: 'SELECT 1; DROP TABLE users' })).error, /run one statement at a time/);
  assert.match((await call({ action: 'query', sql: '  -- nothing' })).error, /nothing to run/);
  assert.doesNotMatch(logged(), /DROP/);
});

const edits = [{ type: 'update', key: { id: '1' }, set: { name: 'x' } }, { type: 'delete', key: { id: '2' } }];

test('apply shows the statements first and runs nothing until confirmed', async () => {
  const { json } = await call({ action: 'apply', table: 'users', changes: edits });
  assert.equal(json.confirm, 'Apply 2 changes to users?');
  assert.deepStrictEqual(json.statements, ["UPDATE `users` SET `name` = 'x' WHERE `id` = '1';", "DELETE FROM `users` WHERE `id` = '2';"]);
  assert.doesNotMatch(logged(), /START TRANSACTION/);
});

test('confirmed edits run in one transaction', async () => {
  const { json } = await call({ action: 'apply', table: 'users', changes: edits, confirm: true });
  assert.equal(json.applied, 2);
  assert.match(logged(), /START TRANSACTION;\nUPDATE `users` SET `name` = 'x' WHERE `id` = '1';\nDELETE FROM `users` WHERE `id` = '2';\nCOMMIT;/);
});

test('the database\'s refusal comes back as the error', async () => {
  const r = await call({ action: 'apply', table: 'users', changes: [{ type: 'insert', values: { id: 'FAIL_ME' } }], confirm: true });
  assert.equal(r.status, 1);
  assert.match(r.error, /Duplicate entry 'FAIL_ME'/);
});

test('views and bad edits are refused before anything runs', async () => {
  assert.match((await call({ action: 'apply', table: 'active_users', changes: edits, confirm: true })).error, /active_users is a view/);
  assert.match((await call({ action: 'apply', table: 'users', changes: [{ type: 'update', key: { id: '1' }, set: { ghost: 'x' } }], confirm: true })).error, /no column ghost in users/);
  assert.match((await call({ action: 'apply', table: 'nope', changes: edits, confirm: true })).error, /no table nope/);
  assert.doesNotMatch(logged(), /START TRANSACTION/);
});

const sessions = () => logged().split('\n').filter((l) => /^db:shell/.test(l)).length;

test('a page of rows takes two database sessions, whatever it asks for', async () => {
  await call({ action: 'rows', table: 'users', sort: { column: 'name', dir: 'asc' }, filter: { column: 'name', op: 'contains', value: 'a' } });
  assert.equal(sessions(), 2);
});

test('each service\'s engine is asked of lerd once, then remembered', async () => {
  hits = {};
  await call({ action: 'tables' });
  await call({ action: 'rows', table: 'users' });
  await call({ action: 'tables', service: 'postgres', database: 'blog' });
  assert.equal(hits['/api/databases'], 1);
  assert.equal(hits['/api/sites'], 3);
});

test('accented text reads back as it is stored, and every MySQL session says it speaks UTF-8', async () => {
  const { json } = await call({ action: 'query', sql: 'SELECT name FROM places' });
  assert.deepStrictEqual(json.rows, [['México - Cancún']]);
  await call({ action: 'rows', table: 'users' });
  await call({ action: 'query', sql: "UPDATE users SET name = 'Cancún'", confirm: true });
  await call({ action: 'apply', table: 'users', changes: [{ type: 'update', key: { id: '1' }, set: { name: 'Cancún' } }], confirm: true });
  const sessions = logged().split(/^db:shell.*$/m).slice(1).map((s) => s.trimStart());
  assert.ok(sessions.length >= 5);
  for (const s of sessions) assert.match(s, /^SET NAMES utf8mb4;/);
});
