const test = require('node:test');
const assert = require('node:assert');
const { toJson, toCsv, toText } = require('../ui/format');

const columns = ['id', 'name'];
const rows = [['1', 'ana'], ['2', null], ['3', 'a, "b"\nc']];

test('JSON is an array of objects keyed by column, nulls kept', () => {
  assert.equal(toJson(columns, rows), JSON.stringify([{ id: '1', name: 'ana' }, { id: '2', name: null }, { id: '3', name: 'a, "b"\nc' }], null, 2));
});

test('CSV quotes what needs quoting and leaves a null empty', () => {
  assert.equal(toCsv(columns, rows), 'id,name\r\n1,ana\r\n2,\r\n3,"a, ""b""\nc"\r\n');
});

test('Text lines the columns up like a database client, NULL spelled out', () => {
  assert.equal(toText(columns, rows), [
    '+----+-----------+',
    '| id | name      |',
    '+----+-----------+',
    '| 1  | ana       |',
    '| 2  | NULL      |',
    '| 3  | a, "b"\\nc |',
    '+----+-----------+',
  ].join('\n'));
});

test('an empty result still shows its columns', () => {
  assert.equal(toText(['a'], []), '+---+\n| a |\n+---+\n+---+');
  assert.equal(toCsv(['a'], []), 'a\r\n');
  assert.equal(toJson(['a'], []), '[]');
});

const { toInserts } = require('../ui/format');

test('SQL INSERT quotes names and values the way each engine reads them', () => {
  const t = { schema: '', name: 'users' };
  assert.equal(toInserts('mysql', t, ['id', 'na`me'], [['1', "o'neil\\"], ['2', null]]),
    "INSERT INTO `users` (`id`, `na``me`) VALUES ('1', 'o''neil\\\\');\nINSERT INTO `users` (`id`, `na``me`) VALUES ('2', NULL);");
  assert.equal(toInserts('postgres', { schema: 'audit', name: 'ev"ents' }, ['id'], [['1']]), `INSERT INTO "audit"."ev""ents" ("id") VALUES ('1');`);
  assert.equal(toInserts('sqlite', t, ['note'], [['back\\slash']]), `INSERT INTO "users" ("note") VALUES ('back\\slash');`);
  assert.equal(toInserts('mysql', t, ['id'], []), '');
});
