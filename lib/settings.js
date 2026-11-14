// What the tab remembers between visits, kept in the plugin's data folder:
// a sandboxed tab has no localStorage of its own.
const fs = require('node:fs');
const path = require('node:path');

const PAGE_SIZES = [50, 100, 250, 500, 1000];
const DEFAULTS = { pageSize: 100, connections: {} };

function readSettings(dir) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(dir, changes) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...readSettings(dir), ...changes }));
}

function savePageSize(dir, size) {
  if (!PAGE_SIZES.includes(size)) throw new Error(`page size ${size} is not one of ${PAGE_SIZES.join(', ')}`);
  save(dir, { pageSize: size });
}

// The caller checked the connection is one of the site's.
function saveConnection(dir, site, { service, database }) {
  save(dir, { connections: { ...readSettings(dir).connections, [site]: { service, database } } });
}

module.exports = { PAGE_SIZES, readSettings, savePageSize, saveConnection };
