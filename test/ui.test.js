// The Database tab in a real browser: ui/ is served as lerd serves it, with
// lerd.js swapped for a stub that answers the plugin's endpoint from fixtures.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const UI = path.join(__dirname, '..', 'ui');

// The stub records every call in window.calls. Rows answers wait while
// window.hold is set, so a test can look at the loading state.
const STUB = `
window.calls = [];
window.hold = false;
const TOTAL = 230;
let pageSize = 100;
const CONNECTIONS = [{ service: 'postgres', database: 'shop', engine: 'postgres' }, { service: 'mysql', database: 'blog', engine: 'mysql' }];
const TABLES = {
  shop: [{ schema: 'public', name: 'users', view: false }, { schema: 'public', name: 'orders', view: false }, { schema: 'audit', name: 'events', view: true }],
  blog: [{ schema: '', name: 'posts', view: false }],
};
let current = CONNECTIONS[0];
const waitForRelease = () => new Promise((r) => { const t = setInterval(() => { if (!window.hold) { clearInterval(t); r(); } }, 10); });
window.lerd = {
  context: { site: 'shop', domain: 'shop.test', branch: '', lang: 'en' },
  async api(p, { body } = {}) {
    const req = JSON.parse(body);
    window.calls.push(req);
    if (window.fail) throw new Error(window.fail);
    if (req.action === 'tables') {
      const list = window.single ? CONNECTIONS.slice(0, 1) : CONNECTIONS;
      if (req.service) current = list.find((c) => c.service === req.service && c.database === req.database);
      return JSON.stringify({ engine: current.engine, connection: current, connections: list, database: current.database,
        notice: window.notice, pageSize, pageSizes: [50, 100, 250], tables: TABLES[current.database],
        operators: ['=', '!=', 'contains', 'is null', 'is not null'] });
    }
    if (req.action === 'page_size') { pageSize = req.size; return JSON.stringify({ pageSize }); }
    if (req.action === 'rows') {
      await waitForRelease();
      const total = req.filter ? 5 : TOTAL;
      const n = Math.min(pageSize, total - req.offset);
      const rows = Array.from({ length: n }, (_, i) => [String(req.offset + i + 1), i === 0 ? null : '<img src=x onerror="window.pwned=1">', '{"a":1,"b":[2,3]}']);
      return JSON.stringify({ engine: current.engine, connection: current, offset: req.offset, limit: pageSize, total, columns: ['id', 'note', 'meta'], keys: req.table === 'events' ? [] : ['id'], rows });
    }
    if (req.action === 'structure') {
      return JSON.stringify({ engine: current.engine, connection: current,
        columns: [{ name: 'id', type: 'bigint', nullable: false, default: null, key: true }, { name: 'note', type: 'text', nullable: true, default: "'x'", key: false }],
        indexes: [{ name: 'users_pkey', definition: 'UNIQUE (id)' }], foreignKeys: [] });
    }
    if (req.action === 'apply') {
      if (!req.confirm) return JSON.stringify({ connection: current, confirm: 'Apply ' + req.changes.length + ' changes to ' + req.table + '?', statements: req.changes.map((c) => c.type.toUpperCase() + ' ...;') });
      if (window.applyFails) throw new Error("Duplicate entry '2' for key 'PRIMARY'\\n\\nexit status 1");
      return JSON.stringify({ connection: current, applied: req.changes.length });
    }
    if (req.action === 'history') return JSON.stringify({ history: ['SELECT * FROM orders', 'SELECT 1'] });
    if (req.action === 'query') {
      if (/;\\s*\\S/.test(req.sql)) throw new Error('run one statement at a time\\n\\nexit status 1');
      if (/^UPDATE/i.test(req.sql) && !req.confirm) return JSON.stringify({ connection: current, confirm: 'This statement can change shop. Run it?', sql: req.sql });
      if (/^UPDATE/i.test(req.sql)) return JSON.stringify({ connection: current, read: false, affected: 2, columns: [], rows: [], ms: 5, truncated: false, cap: 1000 });
      const rows = window.manyRows ? Array.from({ length: 200 }, (_, i) => [String(i + 1), 'row ' + (i + 1)]) : [['1', 'ana'], ['2', null]];
      return JSON.stringify({ connection: current, read: true, columns: ['id', 'name'], rows, ms: 12, truncated: !!window.truncated, cap: 1000 });
    }
    throw new Error('unknown action ' + req.action);
  },
};`;

let server, browser, url;

test.before(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.slice(1);
    if (name === 'lerd.js') return res.end(STUB);
    const file = path.join(UI, name);
    if (!file.startsWith(UI) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : 'text/javascript');
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/site.html`;
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

async function open(setup) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (setup) await page.addInitScript(setup);
  await page.goto(url);
  return { page, errors };
}

const text = (page, sel) => page.locator(sel).textContent();

test('lists the tables with their schema when it is not public, and filters them', async () => {
  const { page, errors } = await open();
  await page.locator('#tables button').first().waitFor();
  assert.deepStrictEqual(await page.locator('#tables button .n').allTextContents(), ['users', 'orders', 'audit.events']);
  assert.equal(await page.locator('#tables button', { hasText: 'audit.events' }).locator('.lerd-pill').textContent(), 'view');
  assert.equal(await text(page, '#engine'), 'PostgreSQL');

  await page.locator('#filter').fill('ORD');
  assert.deepStrictEqual(await page.locator('#tables button .n').allTextContents(), ['orders']);
  await page.locator('#filter').fill('nothing');
  assert.equal(await text(page, '#tables .lerd-empty'), 'No match.');
  assert.deepStrictEqual(errors, []);
});

test('shows a spinner while a table loads, then its first page', async () => {
  const { page, errors } = await open();
  await page.evaluate(() => (window.hold = true));
  await page.locator('#tables button', { hasText: 'users' }).click();
  assert.equal(await text(page, '#grid .loading'), 'Loading users...');
  assert.equal(await page.locator('#grid').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#tables button[aria-current="true"]').textContent(), 'users');

  await page.evaluate(() => (window.hold = false));
  await page.locator('#grid table').waitFor();
  await page.locator('#grid[aria-busy]').waitFor({ state: 'detached' });
  assert.deepStrictEqual(await page.locator('#grid th').allTextContents(), ['id', 'note', 'meta']);
  assert.equal(await page.locator('#grid tbody tr').count(), 100);
  assert.equal(await text(page, '#range'), '1-100 of 230');
  assert.equal(await page.locator('#page').inputValue(), '1');
  assert.equal(await text(page, '#pages'), '3');
  assert.equal(await page.locator('#prev').isDisabled(), true);
  assert.equal(await page.locator('#next').isDisabled(), false);
  assert.deepStrictEqual(errors, []);
});

test('draws a null as NULL and a value as text, never as markup', async () => {
  const { page } = await open();
  await page.locator('#tables button', { hasText: 'users' }).click();
  await page.locator('#grid table').waitFor();
  const first = page.locator('#grid tbody tr').first().locator('td').nth(1);
  assert.equal(await first.textContent(), 'NULL');
  assert.match(await first.getAttribute('class'), /null/);
  assert.equal(await page.locator('#grid img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
});

test('pages with Next, Previous and a typed page number, and stops at the ends', async () => {
  const { page } = await open();
  await page.locator('#tables button', { hasText: 'users' }).click();
  await page.locator('#range', { hasText: '1-100' }).waitFor();

  await page.locator('#next').click();
  await page.locator('#range', { hasText: '101-200' }).waitFor();
  assert.equal(await page.locator('#page').inputValue(), '2');

  await page.locator('#page').fill('3');
  await page.locator('#page').press('Enter');
  await page.locator('#range', { hasText: '201-230' }).waitFor();
  assert.equal(await page.locator('#next').isDisabled(), true);

  await page.locator('#page').fill('99');
  await page.locator('#page').press('Enter');
  await page.locator('#grid[aria-busy]').waitFor({ state: 'detached' });
  assert.equal(await text(page, '#range'), '201-230 of 230');

  await page.locator('#prev').click();
  await page.locator('#range', { hasText: '101-200' }).waitFor();
  const offsets = (await page.evaluate(() => window.calls)).filter((c) => c.action === 'rows').map((c) => c.offset);
  assert.deepStrictEqual(offsets, [0, 100, 200, 200, 100]);
});

test('a new page size is saved and the table reloads from its first page', async () => {
  const { page } = await open();
  assert.deepStrictEqual(await page.locator('#size option').allTextContents(), ['50', '100', '250']);
  await page.locator('#tables button', { hasText: 'users' }).click();
  await page.locator('#range', { hasText: '1-100' }).waitFor();
  await page.locator('#next').click();
  await page.locator('#range', { hasText: '101-200' }).waitFor();

  await page.locator('#size').selectOption('250');
  await page.locator('#range', { hasText: '1-230' }).waitFor();
  assert.equal(await text(page, '#pages'), '1');
  const calls = await page.evaluate(() => window.calls);
  assert.deepStrictEqual(calls.at(-2), { action: 'page_size', size: 250 });
  assert.deepStrictEqual(calls.at(-1), { action: 'rows', table: 'users', schema: 'public', offset: 0, service: 'postgres', database: 'shop' });
});

test('says why when the database cannot be read', async () => {
  const { page } = await open(() => (window.fail = "this site's .env names no database, so there is nothing to browse"));
  await page.locator('#grid .lerd-empty').waitFor();
  assert.equal(await text(page, '#grid .lerd-empty'), "this site's .env names no database, so there is nothing to browse");
  assert.equal(await page.locator('#tables button').count(), 0);
  assert.equal(await page.locator('#filter').isDisabled(), true);
});

test('switches between the site\'s databases, and every call after names the one picked', async () => {
  const { page, errors } = await open();
  await page.locator('#tables button').first().waitFor();
  assert.deepStrictEqual(await page.locator('#conn option').allTextContents(), ['shop · postgres', 'blog · mysql']);
  assert.equal(await page.locator('#conn').isVisible(), true);
  await page.locator('#tables button', { hasText: 'users' }).click();
  await page.locator('#grid table').waitFor();

  await page.locator('#conn').selectOption({ label: 'blog · mysql' });
  await page.locator('#tables button', { hasText: 'posts' }).waitFor();
  assert.deepStrictEqual(await page.locator('#tables button .n').allTextContents(), ['posts']);
  assert.equal(await text(page, '#engine'), 'MySQL / MariaDB');
  assert.equal(await text(page, '#grid .lerd-empty'), 'Pick a table.');
  assert.equal(await text(page, '#title'), '');

  await page.locator('#tables button', { hasText: 'posts' }).click();
  await page.locator('#grid table').waitFor();
  const calls = await page.evaluate(() => window.calls);
  assert.deepStrictEqual(calls.find((c) => c.action === 'tables' && c.service), { action: 'tables', service: 'mysql', database: 'blog' });
  assert.deepStrictEqual(calls.at(-1), { action: 'rows', table: 'posts', schema: '', offset: 0, service: 'mysql', database: 'blog' });
  assert.deepStrictEqual(errors, []);
});

test('a site with one database shows its name instead of a picker', async () => {
  const { page } = await open(() => (window.single = true));
  await page.locator('#tables button').first().waitFor();
  assert.equal(await page.locator('#conn').isVisible(), false);
  assert.equal(await text(page, '#dbname'), 'shop');
});

test('says so when the remembered database is gone', async () => {
  const { page } = await open(() => (window.notice = "mysql / dropped is no longer one of this site's databases, showing postgres / shop"));
  await page.locator('#tables button').first().waitFor();
  assert.equal(await text(page, '#notice'), "mysql / dropped is no longer one of this site's databases, showing postgres / shop");
});

async function openUsers(page) {
  await page.locator('#tables button', { hasText: 'users' }).click();
  await page.locator('#grid table').waitFor();
  await page.locator('#grid[aria-busy]').waitFor({ state: 'detached' });
}
const lastRows = (page) => page.evaluate(() => window.calls.filter((c) => c.action === 'rows').at(-1));

test('clicking a column header sorts by it, then the other way, then not at all', async () => {
  const { page, errors } = await open();
  await openUsers(page);
  await page.locator('#next').click();
  await page.locator('#range', { hasText: '101-' }).waitFor();

  await page.locator('#grid th', { hasText: 'note' }).click();
  await page.locator('#grid th[aria-sort="ascending"]').waitFor();
  assert.deepStrictEqual((await lastRows(page)).sort, { column: 'note', dir: 'asc' });
  assert.equal((await lastRows(page)).offset, 0);
  assert.equal(await page.locator('#grid th[aria-sort="ascending"]').textContent(), 'note ▲');

  await page.locator('#grid th', { hasText: 'note' }).click();
  await page.locator('#grid th[aria-sort="descending"]').waitFor();
  assert.deepStrictEqual((await lastRows(page)).sort, { column: 'note', dir: 'desc' });

  await page.locator('#grid th', { hasText: 'note' }).click();
  await page.locator('#grid th[aria-sort]').waitFor({ state: 'detached' });
  assert.equal((await lastRows(page)).sort, undefined);
  assert.deepStrictEqual(errors, []);
});

test('the filter bar filters on one column, needs no value for the null checks, and clears', async () => {
  const { page } = await open();
  await openUsers(page);
  assert.deepStrictEqual(await page.locator('#fcol option').allTextContents(), ['id', 'note', 'meta']);
  assert.deepStrictEqual(await page.locator('#fop option').allTextContents(), ['=', '!=', 'contains', 'is null', 'is not null']);

  await page.locator('#fcol').selectOption('note');
  await page.locator('#fop').selectOption('contains');
  await page.locator('#fval').fill('abc');
  await page.locator('#fval').press('Enter');
  await page.locator('#range', { hasText: 'of 5' }).waitFor();
  assert.deepStrictEqual((await lastRows(page)).filter, { column: 'note', op: 'contains', value: 'abc' });

  await page.locator('#fop').selectOption('is null');
  assert.equal(await page.locator('#fval').isDisabled(), true);

  await page.locator('#fclear').click();
  await page.locator('#range', { hasText: 'of 230' }).waitFor();
  assert.equal((await lastRows(page)).filter, undefined);
  assert.equal(await page.locator('#fval').inputValue(), '');
});

test('opening another table starts it unsorted and unfiltered', async () => {
  const { page } = await open();
  await openUsers(page);
  await page.locator('#grid th', { hasText: 'note' }).click();
  await page.locator('#grid th[aria-sort]').waitFor();
  await page.locator('#fval').fill('abc');
  await page.locator('#fval').press('Enter');
  await page.locator('#range', { hasText: 'of 5' }).waitFor();

  await page.locator('#tables button', { hasText: 'orders' }).click();
  await page.locator('#range', { hasText: 'of 230' }).waitFor();
  const call = await lastRows(page);
  assert.equal(call.table, 'orders');
  assert.equal(call.sort, undefined);
  assert.equal(call.filter, undefined);
  assert.equal(await page.locator('#fval').inputValue(), '');
});

test('the Structure view lists columns, indexes and foreign keys', async () => {
  const { page, errors } = await open();
  await openUsers(page);
  await page.getByRole('tab', { name: 'Structure' }).click();
  await page.locator('#structure table').first().waitFor();
  assert.equal(await page.locator('#filterbar').isVisible(), false);
  const rows = await page.locator('#structure .columns tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  assert.deepStrictEqual(rows, [['id', 'bigint', 'no', 'NULL', 'primary'], ['note', 'text', 'yes', "'x'", '']]);
  assert.deepStrictEqual(await page.locator('#structure .indexes td').allTextContents(), ['users_pkey', 'UNIQUE (id)']);
  assert.equal(await page.locator('#structure .fks .lerd-empty').textContent(), 'None.');

  await page.getByRole('tab', { name: 'Data' }).click();
  await page.locator('#grid table').waitFor();
  assert.equal(await page.locator('#structure').isVisible(), false);
  assert.deepStrictEqual(errors, []);
});

test('clicking a cell shows its whole value, JSON laid out, and closes', async () => {
  const { page } = await open();
  await openUsers(page);
  await page.locator('#grid tbody tr').nth(1).locator('td').nth(2).click();
  assert.equal(await page.locator('#cell').isVisible(), true);
  const grid = await page.locator('#grid').boundingBox();
  const panel = await page.locator('#cell').boundingBox();
  assert.ok(panel.y >= grid.y + grid.height - 1, 'the panel opens under the rows');
  assert.ok(Math.abs(panel.width - grid.width) <= 1, 'the panel spans the rows\' full width');
  assert.equal(await text(page, '#cell-name'), 'meta');
  assert.equal(await text(page, '#cell-value'), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');

  await page.locator('#grid tbody tr').first().locator('td').nth(1).click();
  assert.equal(await text(page, '#cell-value'), 'NULL');
  await page.locator('#grid tbody tr').nth(1).locator('td').nth(1).click();
  assert.equal(await text(page, '#cell-value'), '<img src=x onerror="window.pwned=1">');
  assert.equal(await page.locator('#cell img').count(), 0);

  await page.locator('#cell-close').click();
  assert.equal(await page.locator('#cell').isVisible(), false);
});

async function openQuery(page) {
  await page.locator('#tables button').first().waitFor();
  await page.locator('#sqlbtn').click();
  await page.locator('#sql').waitFor();
}
const queries = (page) => page.evaluate(() => window.calls.filter((c) => c.action === 'query'));

test('the SQL editor runs a query with Ctrl+Enter and shows it as a table', async () => {
  const { page, errors } = await open();
  await openQuery(page);
  assert.equal(await text(page, '#title'), 'SQL query');
  assert.equal(await page.locator('#views').isVisible(), false);
  await page.locator('#sql').fill('SELECT id, name FROM users');
  await page.locator('#sql').press('Control+Enter');
  await page.locator('#qresult table').waitFor();
  assert.deepStrictEqual(await page.locator('#qresult th').allTextContents(), ['id', 'name']);
  assert.equal(await page.locator('#qresult tbody tr').nth(1).locator('td').nth(1).textContent(), 'NULL');
  assert.equal(await text(page, '#qmeta'), '2 rows · 12 ms');
  assert.deepStrictEqual(await queries(page), [{ action: 'query', sql: 'SELECT id, name FROM users', service: 'postgres', database: 'shop' }]);
  assert.deepStrictEqual(errors, []);
});

test('a result switches between Table, JSON, Text and CSV', async () => {
  const { page } = await open();
  await openQuery(page);
  await page.locator('#sql').fill('SELECT id, name FROM users');
  await page.locator('#run').click();
  await page.locator('#qresult table').waitFor();
  await page.getByRole('tab', { name: 'JSON' }).click();
  assert.equal(await text(page, '#qresult pre'), JSON.stringify([{ id: '1', name: 'ana' }, { id: '2', name: null }], null, 2));
  await page.getByRole('tab', { name: 'Text' }).click();
  assert.equal(await text(page, '#qresult pre'), '+----+------+\n| id | name |\n+----+------+\n| 1  | ana  |\n| 2  | NULL |\n+----+------+');
  await page.getByRole('tab', { name: 'CSV' }).click();
  assert.equal(await text(page, '#qresult pre'), 'id,name\r\n1,ana\r\n2,\r\n');
  await page.getByRole('tab', { name: 'Table' }).click();
  assert.equal(await page.locator('#qresult table').count(), 1);
});

test('a write asks first: Cancel sends nothing, Run sends it confirmed', async () => {
  const { page } = await open();
  await openQuery(page);
  await page.locator('#sql').fill("UPDATE users SET name = 'x'");
  await page.locator('#run').click();
  await page.locator('#confirm[open]').waitFor();
  assert.equal(await text(page, '#confirm-text'), 'This statement can change shop. Run it?');
  assert.equal(await text(page, '#confirm-sql'), "UPDATE users SET name = 'x'");
  await page.locator('#confirm-cancel').click();
  await page.locator('#confirm[open]').waitFor({ state: 'detached' });
  assert.equal((await queries(page)).length, 1);
  assert.equal(await text(page, '#qmeta'), 'Not run.');

  await page.locator('#run').click();
  await page.locator('#confirm[open]').waitFor();
  await page.locator('#confirm-run').click();
  await page.locator('#qmeta', { hasText: 'changed' }).waitFor();
  assert.equal(await text(page, '#qmeta'), '2 rows changed · 5 ms');
  assert.equal((await queries(page)).at(-1).confirm, true);
});

test('an error shows in the result, and a cut result says so', async () => {
  const { page } = await open(() => (window.truncated = true));
  await openQuery(page);
  await page.locator('#sql').fill('SELECT 1; SELECT 2');
  await page.locator('#run').click();
  await page.locator('#qresult .lerd-empty', { hasText: 'one statement' }).waitFor();
  assert.equal(await text(page, '#qresult .lerd-empty'), 'run one statement at a time');

  await page.locator('#sql').fill('SELECT id, name FROM users');
  await page.locator('#run').click();
  await page.locator('#qresult table').waitFor();
  assert.equal(await text(page, '#qmeta'), 'First 1000 rows shown, add a LIMIT to choose · 12 ms');
});

test('history puts an earlier query back in the editor', async () => {
  const { page } = await open();
  await openQuery(page);
  await page.locator('#history option', { hasText: 'SELECT * FROM orders' }).waitFor({ state: 'attached' });
  await page.locator('#history').selectOption({ label: 'SELECT * FROM orders' });
  assert.equal(await page.locator('#sql').inputValue(), 'SELECT * FROM orders');
});

test('picking a table leaves the editor for that table\'s data', async () => {
  const { page } = await open();
  await openQuery(page);
  await openUsers(page);
  assert.equal(await page.locator('#query').isVisible(), false);
  assert.equal(await text(page, '#title'), 'users');
});

const dbl = (page, row, col) => page.locator('#grid tbody tr').nth(row).locator('td').nth(col).dblclick();
const cell = (page, row, col) => page.locator('#grid tbody tr').nth(row).locator('td').nth(col);

test('double-click edits a cell in place; Enter stages it, Discard puts it back', async () => {
  const { page, errors } = await open();
  await openUsers(page);
  await dbl(page, 1, 1);
  await page.locator('#grid td input').fill('changed');
  await page.locator('#grid td input').press('Enter');
  assert.equal(await cell(page, 1, 1).textContent(), 'changed');
  assert.match(await cell(page, 1, 1).getAttribute('class'), /changed/);
  assert.equal(await text(page, '#changes-count'), '1 change');

  await dbl(page, 2, 1);
  await page.locator('#grid td input').fill('ignored');
  await page.locator('#grid td input').press('Escape');
  assert.equal(await cell(page, 2, 1).textContent(), '<img src=x onerror="window.pwned=1">');
  assert.equal(await text(page, '#changes-count'), '1 change');

  await page.locator('#discard').click();
  assert.equal(await page.locator('#changes').isVisible(), false);
  assert.equal(await cell(page, 1, 1).textContent(), '<img src=x onerror="window.pwned=1">');
  assert.deepStrictEqual(errors, []);
});

test('Commit shows the statements, then applies every staged edit and reloads', async () => {
  const { page } = await open();
  await openUsers(page);
  await dbl(page, 1, 1);
  await page.locator('#grid td input').fill('x');
  await page.locator('#grid td input').press('Enter');
  await cell(page, 2, 2).click();
  await page.locator('#cell-null').check();
  await page.locator('#cell-set').click();
  assert.equal(await cell(page, 2, 2).textContent(), 'NULL');
  await cell(page, 3, 0).click();
  await page.locator('#cell-delete').click();
  assert.match(await page.locator('#grid tbody tr').nth(3).getAttribute('class'), /deleted/);
  await page.locator('#addrow').click();
  await dbl(page, 0, 1);
  await page.locator('#grid td input').fill('new');
  await page.locator('#grid td input').press('Enter');
  assert.equal(await text(page, '#changes-count'), '4 changes');

  await page.locator('#commit').click();
  await page.locator('#confirm[open]').waitFor();
  assert.equal(await text(page, '#confirm-text'), 'Apply 4 changes to users?');
  assert.equal(await text(page, '#confirm-sql'), 'INSERT ...;\nUPDATE ...;\nUPDATE ...;\nDELETE ...;');
  await page.locator('#confirm-run').click();
  await page.locator('#changes').waitFor({ state: 'hidden' });
  const calls = await page.evaluate(() => window.calls);
  const apply = calls.filter((c) => c.action === 'apply').at(-1);
  assert.equal(apply.confirm, true);
  assert.deepStrictEqual(apply.changes, [
    { type: 'insert', values: { note: 'new' } },
    { type: 'update', key: { id: '2' }, set: { note: 'x' } },
    { type: 'update', key: { id: '3' }, set: { meta: null } },
    { type: 'delete', key: { id: '4' } },
  ]);
  assert.equal(calls.at(-1).action, 'rows');
});

test('a failed commit keeps the edits and says why', async () => {
  const { page } = await open(() => (window.applyFails = true));
  await openUsers(page);
  await dbl(page, 1, 1);
  await page.locator('#grid td input').fill('x');
  await page.locator('#grid td input').press('Enter');
  await page.locator('#commit').click();
  await page.locator('#confirm-run').click();
  await page.locator('#changes-error:not(:empty)').waitFor();
  assert.equal(await text(page, '#changes-error'), "Duplicate entry '2' for key 'PRIMARY'");
  assert.equal(await text(page, '#changes-count'), '1 change');
});

test('a view or a table without a primary key is read only', async () => {
  const { page } = await open();
  await page.locator('#tables button', { hasText: 'audit.events' }).click();
  await page.locator('#grid table').waitFor();
  await page.locator('#grid[aria-busy]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#addrow').isVisible(), false);
  assert.equal(await page.locator('#readonly').isVisible(), true);
  await dbl(page, 1, 1);
  assert.equal(await page.locator('#grid td input').count(), 0);
  await cell(page, 1, 1).click();
  assert.equal(await page.locator('#cell-edit').isVisible(), false);
});

test('moving away from unsaved edits asks first', async () => {
  const { page } = await open();
  await openUsers(page);
  await dbl(page, 1, 1);
  await page.locator('#grid td input').fill('x');
  await page.locator('#grid td input').press('Enter');

  await page.locator('#next').click();
  await page.locator('#confirm[open]').waitFor();
  assert.equal(await text(page, '#confirm-text'), 'Discard 1 unsaved change?');
  await page.locator('#confirm-cancel').click();
  assert.equal(await text(page, '#range'), '1-100 of 230');
  assert.equal(await text(page, '#changes-count'), '1 change');

  await page.locator('#next').click();
  await page.locator('#confirm-run').click();
  await page.locator('#range', { hasText: '101-200' }).waitFor();
  assert.equal(await page.locator('#changes').isVisible(), false);
});

// The dashboard's frame blocks the Clipboard API; copying must still work.
const blockClipboard = () => {
  Object.defineProperty(document, 'permissionsPolicy', { value: { allowsFeature: (f) => f !== 'clipboard-write' } });
  navigator.clipboard.writeText = () => { window.clipboardApiUsed = true; return Promise.reject(new Error('blocked')); };
  document.execCommand = (cmd) => { if (cmd === 'copy') window.copied = document.activeElement.value; return true; };
};

test('Copy works where the Clipboard API is blocked, for a cell and for a result', async () => {
  const { page } = await open(blockClipboard);
  await openUsers(page);
  await page.locator('#grid tbody tr').nth(1).locator('td').nth(2).click();
  await page.locator('#cell-copy').click();
  assert.equal(await page.evaluate(() => window.copied), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  assert.equal(await page.evaluate(() => window.clipboardApiUsed), undefined);

  await page.locator('#sqlbtn').click();
  await page.locator('#sql').fill('SELECT id, name FROM users');
  await page.locator('#run').click();
  await page.locator('#qresult table').waitFor();
  await page.getByRole('tab', { name: 'JSON' }).click();
  await page.locator('#qcopy').click();
  assert.equal(await page.evaluate(() => window.copied), JSON.stringify([{ id: '1', name: 'ana' }, { id: '2', name: null }], null, 2));
});

test('Copy rows copies the page as CSV, JSON or SQL INSERT, and Copy row one row as JSON', async () => {
  const { page } = await open(blockClipboard);
  await page.locator('#tables button', { hasText: 'audit.events' }).click();
  await page.locator('#grid table').waitFor();
  await page.locator('#grid[aria-busy]').waitFor({ state: 'detached' });
  await page.locator('#copyas').selectOption('sql');
  const sql = await page.evaluate(() => window.copied);
  assert.equal(sql.split('\n').length, 100);
  assert.equal(sql.split('\n')[0], `INSERT INTO "audit"."events" ("id", "note", "meta") VALUES ('1', NULL, '{"a":1,"b":[2,3]}');`);
  assert.equal(await page.locator('#copyas').inputValue(), '');

  await page.locator('#copyas').selectOption('csv');
  // A text field keeps only \n, so CSV copied through the fallback ends lines with it.
  assert.equal((await page.evaluate(() => window.copied)).split(/\r?\n/)[0], 'id,note,meta');
  await page.locator('#copyas').selectOption('json');
  assert.deepStrictEqual(JSON.parse(await page.evaluate(() => window.copied))[0], { id: '1', note: null, meta: '{"a":1,"b":[2,3]}' });

  await page.locator('#grid tbody tr').nth(1).locator('td').first().click();
  await page.locator('#cell-copyrow').click();
  assert.deepStrictEqual(JSON.parse(await page.evaluate(() => window.copied)), { id: '2', note: '<img src=x onerror="window.pwned=1">', meta: '{"a":1,"b":[2,3]}' });
});

test('a cell of a long query result opens in a panel that stays on screen', async () => {
  const { page } = await open(() => (window.manyRows = true));
  await openQuery(page);
  await page.locator('#sql').fill('SELECT id, name FROM users');
  await page.locator('#run').click();
  await page.locator('#qresult table').waitFor();
  await page.locator('#qresult tbody tr').first().locator('td').nth(1).click();
  assert.equal(await page.locator('#cell').isVisible(), true);
  assert.equal(await text(page, '#cell-name'), 'name');
  assert.equal(await text(page, '#cell-value'), 'row 1');
  assert.equal(await page.locator('#cell-edit').isVisible(), false);
  const result = await page.locator('#qresult').boundingBox();
  const panel = await page.locator('#cell').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(panel.y >= result.y + result.height - 1, 'the panel opens under the result');
  assert.ok(panel.y + panel.height <= viewport.height + 1, `the panel ends inside the frame (${Math.round(panel.y + panel.height)} > ${viewport.height})`);
});
