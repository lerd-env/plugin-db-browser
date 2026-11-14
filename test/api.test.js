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
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers['x-lerd-plugin-token'] !== TOKEN) return res.writeHead(401).end('no token');
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
