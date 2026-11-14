# Database browser

Adds a **Database** tab to every site that has a database (on lerd 1.38 the tab shows on every site and says when there is none). The left side lists the site's tables, picking one shows its rows a page at a time. Pick how many rows a page shows (50 to 1000, remembered for next time), and move with Previous and Next or type a page number.

It works with the database the site's `.env` points at: MySQL, MariaDB and PostgreSQL through `lerd db:shell`, including external servers added with `lerd db:use`, and SQLite through PHP in the site's container.

The tab only works from the dashboard on this machine, not from another device on the LAN.

## Known limits

- MySQL and MariaDB print a null and the text `NULL` the same way, so both show as NULL.
- Opening the tab starts the site's database service if it was stopped.
- The tab shows the database of the site's main folder, not of a worktree with its own database.
