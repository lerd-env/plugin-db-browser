// The queries run on each site, newest first, kept in the plugin's data folder.
const fs = require('node:fs');
const path = require('node:path');

const KEEP = 50;
const file = (dir) => path.join(dir, 'history.json');

function readAll(dir) {
  try {
    const all = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

function readHistory(dir, site) {
  return readAll(dir)[site] ?? [];
}

function addHistory(dir, site, sql) {
  const all = readAll(dir);
  all[site] = [sql, ...(all[site] ?? []).filter((q) => q !== sql)].slice(0, KEEP);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(dir), JSON.stringify(all));
}

module.exports = { readHistory, addHistory };
