const test = require('node:test');
const assert = require('node:assert');
const E = require('../ui/edits');

const page = { columns: ['id', 'name', 'note'], keys: ['id'], rows: [['1', 'ana', null], ['2', 'bob', 'x'], ['3', 'cy', 'y']] };

test('an edit back to the original value un-stages it', () => {
  const e = E.createEdits();
  E.stageUpdate(e, page, 0, 'name', 'anna');
  assert.equal(E.count(e), 1);
  assert.deepStrictEqual(E.shown(e, page, 0, 'name'), { value: 'anna', changed: true });
  E.stageUpdate(e, page, 0, 'name', 'ana');
  assert.equal(E.count(e), 0);
  assert.deepStrictEqual(E.shown(e, page, 0, 'name'), { value: 'ana', changed: false });
  E.stageUpdate(e, page, 0, 'note', null);
  assert.equal(E.count(e), 0);
});

test('several edits on one row are one change, and a deleted row drops its edits', () => {
  const e = E.createEdits();
  E.stageUpdate(e, page, 1, 'name', 'b');
  E.stageUpdate(e, page, 1, 'note', null);
  assert.equal(E.count(e), 1);
  E.toggleDelete(e, 1);
  assert.equal(E.count(e), 1);
  assert.deepStrictEqual(E.toChanges(e, page), [{ type: 'delete', key: { id: '2' } }]);
  E.toggleDelete(e, 1);
  assert.equal(E.count(e), 0);
});

test('new rows come first, newest on top, holding only the columns typed in', () => {
  const e = E.createEdits();
  E.addInsert(e);
  E.addInsert(e);
  E.stageInsert(e, 0, 'name', 'newest');
  E.stageInsert(e, 1, 'note', null);
  assert.equal(E.count(e), 2);
  E.stageUpdate(e, page, 2, 'name', 'c');
  E.toggleDelete(e, 0);
  assert.deepStrictEqual(E.toChanges(e, page), [
    { type: 'insert', values: { name: 'newest' } },
    { type: 'insert', values: { note: null } },
    { type: 'update', key: { id: '3' }, set: { name: 'c' } },
    { type: 'delete', key: { id: '1' } },
  ]);
  E.removeInsert(e, 0);
  assert.equal(E.count(e), 3);
});

test('a row is named by every primary key column', () => {
  const pair = { columns: ['a', 'v', 'b'], keys: ['a', 'b'], rows: [['1', 'x', '2']] };
  const e = E.createEdits();
  E.stageUpdate(e, pair, 0, 'v', 'y');
  assert.deepStrictEqual(E.toChanges(e, pair), [{ type: 'update', key: { a: '1', b: '2' }, set: { v: 'y' } }]);
});
