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
