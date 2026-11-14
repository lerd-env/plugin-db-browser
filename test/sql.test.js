const test = require('node:test');
const assert = require('node:assert');
const { buildPage, OPERATORS } = require('../lib/sql');

const columns = [{ name: 'id', key: true }, { name: 'name', key: false }, { name: 'we`ird"col', key: false }];
const base = { engine: 'mysql', table: { schema: '', name: 'users' }, columns, limit: 50, offset: 100 };

test('a page is ordered by the primary key so paging is stable', () => {
  const { sql, countSql } = buildPage(base);
  assert.equal(sql, 'SELECT * FROM `users` ORDER BY `id` ASC LIMIT 50 OFFSET 100;');
  assert.equal(countSql, 'SELECT COUNT(*) FROM `users`;');
});

test('a table without a primary key keeps the database order', () => {
  const { sql } = buildPage({ ...base, columns: [{ name: 'a', key: false }] });
  assert.equal(sql, 'SELECT * FROM `users` LIMIT 50 OFFSET 100;');
});

test('a sort names a known column and a direction, quoted for the engine', () => {
  assert.equal(buildPage({ ...base, sort: { column: 'name', dir: 'desc' } }).sql, 'SELECT * FROM `users` ORDER BY `name` DESC LIMIT 50 OFFSET 100;');
  const pg = buildPage({ ...base, engine: 'postgres', table: { schema: 'public', name: 'users' }, sort: { column: 'we`ird"col', dir: 'asc' } });
  assert.equal(pg.sql, 'SELECT * FROM "public"."users" ORDER BY "we`ird""col" ASC LIMIT 50 OFFSET 100;');
});

test('a filter escapes its value for each engine and counts what it matches', () => {
  const my = buildPage({ ...base, filter: { column: 'name', op: 'contains', value: "o'neil\\" } });
  assert.equal(my.sql, "SELECT * FROM `users` WHERE `name` LIKE '%o''neil\\\\%' ORDER BY `id` ASC LIMIT 50 OFFSET 100;");
  assert.equal(my.countSql, "SELECT COUNT(*) FROM `users` WHERE `name` LIKE '%o''neil\\\\%';");
  const lite = buildPage({ ...base, engine: 'sqlite', filter: { column: 'name', op: '=', value: "o'neil\\" } });
  assert.equal(lite.sql, `SELECT * FROM "users" WHERE "name" = 'o''neil\\' ORDER BY "id" ASC LIMIT 50 OFFSET 100;`);
});

test('every operator the UI offers builds, and the null checks take no value', () => {
  const where = (op, value = 'x') => buildPage({ ...base, filter: { column: 'name', op, value } }).countSql.replace('SELECT COUNT(*) FROM `users` WHERE ', '').replace(/;$/, '');
  assert.deepStrictEqual(OPERATORS, ['=', '!=', '<', '>', '<=', '>=', 'contains', 'starts with', 'is null', 'is not null']);
  assert.deepStrictEqual(OPERATORS.map((op) => where(op)), [
    "`name` = 'x'", "`name` <> 'x'", "`name` < 'x'", "`name` > 'x'", "`name` <= 'x'", "`name` >= 'x'",
    "`name` LIKE '%x%'", "`name` LIKE 'x%'", '`name` IS NULL', '`name` IS NOT NULL',
  ]);
});

test('postgres compares text with a cast, so a filter on a number or a date column works', () => {
  const pg = buildPage({ ...base, engine: 'postgres', filter: { column: 'id', op: 'contains', value: '4' } });
  assert.match(pg.sql, /WHERE CAST\("id" AS TEXT\) LIKE '%4%'/);
});

test('anything that is not a known column, direction or operator is refused by name', () => {
  assert.throws(() => buildPage({ ...base, sort: { column: 'password; --', dir: 'asc' } }), /no column password; -- in users/);
  assert.throws(() => buildPage({ ...base, sort: { column: 'name', dir: 'sideways' } }), /sort direction sideways is not asc or desc/);
  assert.throws(() => buildPage({ ...base, filter: { column: 'nope', op: '=', value: 'x' } }), /no column nope in users/);
  assert.throws(() => buildPage({ ...base, filter: { column: 'name', op: 'OR 1=1 --', value: 'x' } }), /filter operator OR 1=1 -- is not one of/);
});
