const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { readHistory, addHistory } = require('../lib/history');

const dir = path.join(__dirname, 'fixtures', 'history-data');

test('history keeps each site\'s latest queries first, once each, at most 50', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepStrictEqual(readHistory(dir, 'shop'), []);
  addHistory(dir, 'shop', 'SELECT 1');
  addHistory(dir, 'shop', 'SELECT 2');
  addHistory(dir, 'shop', 'SELECT 1');
  addHistory(dir, 'blog', 'SELECT 3');
  assert.deepStrictEqual(readHistory(dir, 'shop'), ['SELECT 1', 'SELECT 2']);
  assert.deepStrictEqual(readHistory(dir, 'blog'), ['SELECT 3']);
  for (let i = 0; i < 60; i++) addHistory(dir, 'shop', `SELECT ${i}`);
  assert.equal(readHistory(dir, 'shop').length, 50);
  assert.equal(readHistory(dir, 'shop')[0], 'SELECT 59');
  fs.writeFileSync(path.join(dir, 'history.json'), 'not json');
  assert.deepStrictEqual(readHistory(dir, 'shop'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
