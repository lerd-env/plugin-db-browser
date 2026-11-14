// Edits staged on one page of a table until they are committed or discarded:
// cell changes per row, rows marked for deletion, and new rows. page is the
// rows answer: columns, rows and the primary key's column names.
(function (exports) {
  function createEdits() {
    return { updates: new Map(), deletes: new Set(), inserts: [] };
  }

  const original = (page, row, column) => page.rows[row][page.columns.indexOf(column)];

  // Setting a cell back to what the database holds drops the edit.
  function stageUpdate(e, page, row, column, value) {
    const set = e.updates.get(row) ?? {};
    if (value === original(page, row, column)) delete set[column];
    else set[column] = value;
    if (Object.keys(set).length) e.updates.set(row, set);
    else e.updates.delete(row);
  }

  // Deleting a row drops its cell edits, which would never be written.
  function toggleDelete(e, row) {
    if (e.deletes.has(row)) return e.deletes.delete(row);
    e.deletes.add(row);
    e.updates.delete(row);
  }

  // A new row goes on top; the columns never typed into take their defaults.
  function addInsert(e) {
    e.inserts.unshift({});
  }

  function stageInsert(e, index, column, value) {
    e.inserts[index][column] = value;
  }

  function removeInsert(e, index) {
    e.inserts.splice(index, 1);
  }

  function count(e) {
    return e.inserts.length + e.updates.size + e.deletes.size;
  }

  function shown(e, page, row, column) {
    const set = e.updates.get(row);
    if (set && column in set) return { value: set[column], changed: true };
    return { value: original(page, row, column), changed: false };
  }

  function toChanges(e, page) {
    const key = (row) => Object.fromEntries(page.keys.map((k) => [k, original(page, row, k)]));
    const sorted = (rows) => [...rows].sort((a, b) => a - b);
    return [
      ...e.inserts.map((values) => ({ type: 'insert', values: { ...values } })),
      ...sorted(e.updates.keys()).map((row) => ({ type: 'update', key: key(row), set: { ...e.updates.get(row) } })),
      ...sorted(e.deletes).map((row) => ({ type: 'delete', key: key(row) })),
    ];
  }

  Object.assign(exports, { createEdits, stageUpdate, toggleDelete, addInsert, stageInsert, removeInsert, count, shown, toChanges });
})(typeof module === 'object' ? module.exports : (window.dbEdits = {}));
