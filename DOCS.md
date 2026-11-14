# Database browser

Adds a **Database** tab to every site that has a database (on lerd 1.38 the tab shows on every site and says when there is none). The left side lists the site's tables, picking one shows its rows a page at a time. Pick how many rows a page shows (50 to 1000, remembered for next time), and move with Previous and Next or type a page number.

Click a column header to sort by it, again for the other direction, and a third time to go back to the table's own order, which is its primary key so pages never shift. The filter bar under the toolbar narrows the rows on one column: equal, not equal, the comparisons, contains, starts with, or whether it is null. Click any cell to see its whole value in a side panel, with JSON laid out and a Copy button. **Structure** next to **Data** lists the table's columns with their types, nullability, defaults and primary key, its indexes and its foreign keys.

When a site points at more than one database, such as a second connection string in its `.env`, the picker above the table list switches between them, and the tab remembers your pick for that site. It only ever offers the site's own databases, never another site's on the same server.

It works with MySQL, MariaDB and PostgreSQL through `lerd db:shell`, including external servers added with `lerd db:use`, and SQLite through PHP in the site's container.

The tab only works from the dashboard on this machine, not from another device on the LAN.

## Known limits

- MySQL and MariaDB print a null and the text `NULL` the same way, so both show as NULL.
- Opening the tab starts the site's database service if it was stopped.
- The tab shows the databases of the site's main folder, not of a worktree with its own database.
- On a lerd older than 1.39 the picker is not there and the tab opens the database `lerd db:shell` picks.
