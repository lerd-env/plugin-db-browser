const test = require('node:test');
const assert = require('node:assert');
const { buildChanges } = require('../lib/sql');

const columns = [{ name: 'id', key: true }, { name: 'name', key: false }, { name: 'note', key: false }];
const table = { schema: '', name: 'users' };
const build = (changes, engine = 'mysql', cols = columns) => buildChanges({ engine, table, columns: cols, changes });

test('an update sets the edited columns on the row its primary key names', () => {
  assert.deepStrictEqual(build([{ type: 'update', key: { id: '7' }, set: { name: "o'neil\\", note: null } }]), [
    "UPDATE `users` SET `name` = 'o''neil\\\\', `note` = NULL WHERE `id` = '7';",
  ]);
  assert.deepStrictEqual(build([{ type: 'update', key: { id: '7' }, set: { name: 'x' } }], 'postgres', columns).map((s) => s), [
    `UPDATE "users" SET "name" = 'x' WHERE "id" = '7';`,
  ]);
});

test('an insert lists only the columns given, and falls back to defaults for an empty row', () => {
  assert.deepStrictEqual(build([{ type: 'insert', values: { name: 'ana', note: null } }]), ["INSERT INTO `users` (`name`, `note`) VALUES ('ana', NULL);"]);
  assert.deepStrictEqual(build([{ type: 'insert', values: {} }]), ['INSERT INTO `users` () VALUES ();']);
  assert.deepStrictEqual(build([{ type: 'insert', values: {} }], 'postgres'), ['INSERT INTO "users" DEFAULT VALUES;']);
  assert.deepStrictEqual(build([{ type: 'insert', values: {} }], 'sqlite'), ['INSERT INTO "users" DEFAULT VALUES;']);
});

test('a delete names its row by every primary key column', () => {
  const pair = [{ name: 'a', key: true }, { name: 'b', key: true }, { name: 'v', key: false }];
  assert.deepStrictEqual(build([{ type: 'delete', key: { a: '1', b: '2' } }], 'sqlite', pair), [`DELETE FROM "users" WHERE "a" = '1' AND "b" = '2';`]);
});

test('changes keep their order', () => {
  const sql = build([{ type: 'insert', values: { name: 'a' } }, { type: 'update', key: { id: '1' }, set: { name: 'b' } }, { type: 'delete', key: { id: '2' } }]);
  assert.deepStrictEqual(sql.map((s) => s.split(' ')[0]), ['INSERT', 'UPDATE', 'DELETE']);
});

test('a row is only ever named by its whole primary key', () => {
  const pair = [{ name: 'a', key: true }, { name: 'b', key: true }];
  assert.throws(() => build([{ type: 'delete', key: { a: '1' } }], 'mysql', pair), /a row is named by its primary key a, b/);
  assert.throws(() => build([{ type: 'update', key: { name: 'x' }, set: { note: 'y' } }]), /a row is named by its primary key id/);
  assert.throws(() => build([{ type: 'update', key: { id: null }, set: { note: 'y' } }]), /a row is named by its primary key id/);
  assert.throws(() => build([{ type: 'delete', key: { id: '1' } }], 'mysql', [{ name: 'id', key: false }]), /users has no primary key, so its rows cannot be edited here/);
});

test('unknown columns, empty updates and unknown change types are refused by name', () => {
  assert.throws(() => build([{ type: 'update', key: { id: '1' }, set: { 'name`=1;--': 'x' } }]), /no column name`=1;-- in users/);
  assert.throws(() => build([{ type: 'insert', values: { ghost: 'x' } }]), /no column ghost in users/);
  assert.throws(() => build([{ type: 'update', key: { id: '1' }, set: {} }]), /an update needs at least one column/);
  assert.throws(() => build([{ type: 'upsert' }]), /change type upsert is not insert, update or delete/);
  assert.throws(() => build([]), /no changes to apply/);
  assert.throws(() => build([{ type: 'insert', values: { name: 5 } }]), /value for name must be text or null/);
});
