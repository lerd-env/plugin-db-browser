# Database browser for Lerd

A **Database** tab on every Lerd site that has a database: browse its tables, sort and filter the rows, read a table's structure, run SQL, and edit rows with changes committed together in one transaction. It works with MySQL, MariaDB and PostgreSQL through `lerd db:shell`, and with SQLite through PHP in the site's container, so it needs no database client on the machine and no credentials of its own.

![Browsing a table](docs/data.png)

![Running a query](docs/query.png)

![A table's structure](docs/structure.png)

## Install

Clone this repository and run `lerd plugin install /path/to/db-browser`. It needs Lerd 1.38 or later. A Lerd that knows a site tab's `when: database` shows the tab only on sites with a database and offers the database picker; an older one shows it on every site and opens the database `lerd db:shell` picks.

## How it stays safe

The tab only offers the databases Lerd says the site points at, never another site's on the same server. Table and column names are picked from what the database lists, never taken as typed, and filter values go into the SQL as escaped literals. A typed statement that can change the database, and every set of row edits, is shown and confirmed before it runs. The endpoint behind the tab answers only the dashboard on this machine.

## Development

```bash
npm install
npm test
```

The tests drive the endpoint against a stand-in for `lerd db:shell` and the tab in a real browser with a stand-in for Lerd's API, so they need neither Lerd nor a database.
