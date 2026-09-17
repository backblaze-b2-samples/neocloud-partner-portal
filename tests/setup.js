// Use in-memory SQLite for all server tests — avoids touching the real DB file.
// server/db.js passes this through verbatim rather than path-resolving it, so it
// is a genuine transient database: nothing survives the process, which means the
// built-in role seed runs fresh on every run.
process.env.DB_PATH = ':memory:';

// Pin the protected-account list to the values the admin-routes tests assume.
// Production code reads this from .env (no default), so tests must declare it.
process.env.PROTECTED_ACCOUNT_EMAIL = 'klott@backblaze.com,demo@backblaze.com';
