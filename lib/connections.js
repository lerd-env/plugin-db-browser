// Which databases the tab may open for a site: the ones lerd says the site
// points at, never another site's on the same server.

const ENGINES = { mysql: 'mysql', mariadb: 'mysql', postgres: 'postgres' };

// The site's own default, which db:shell resolves by itself: a SQLite site, or
// a lerd from before /api/sites listed each site's databases.
const SITE_DEFAULT = { service: '', database: '', engine: '' };

const label = (c) => `${c.service} / ${c.database}`;
const same = (a, b) => a.service === b.service && a.database === b.database;

// site is the site's entry in /api/sites, services is /api/databases.
function connectionsFor(site, services) {
  if (!site.databases?.length) return [{ ...SITE_DEFAULT }];
  return site.databases.map(({ service, database }) => {
    const svc = services.find((s) => s.service === service);
    if (!svc) throw new Error(`service ${service} is not one lerd lists`);
    const engine = ENGINES[svc.family];
    if (!engine) throw new Error(`${service} speaks ${svc.family}, which this plugin cannot read`);
    return { service, database, engine };
  });
}

// requested comes from the request and must be one of the site's; remembered
// comes from the settings and may have gone stale since.
function pickConnection(list, requested, remembered) {
  if (requested?.service) {
    const conn = list.find((c) => same(c, requested));
    if (!conn) throw new Error(`${label(requested)} is not one of this site's databases`);
    return { conn };
  }
  if (remembered?.service) {
    const conn = list.find((c) => same(c, remembered));
    if (conn) return { conn };
    return { conn: list[0], notice: `${label(remembered)} is no longer one of this site's databases, showing ${list[0].service ? label(list[0]) : 'the site database'}` };
  }
  return { conn: list[0] };
}

module.exports = { connectionsFor, pickConnection, label };
