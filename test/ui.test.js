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
      return JSON.stringify({ engine: current.engine, connection: current, offset: req.offset, limit: pageSize, total, columns: ['id', 'note', 'meta'], keys: ['id'], rows });
    }
    if (req.action === 'structure') {
      return JSON.stringify({ engine: current.engine, connection: current,
        columns: [{ name: 'id', type: 'bigint', nullable: false, default: null, key: true }, { name: 'note', type: 'text', nullable: true, default: "'x'", key: false }],
        indexes: [{ name: 'users_pkey', definition: 'UNIQUE (id)' }], foreignKeys: [] });
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
