// Use in-memory SQLite for all server tests — avoids touching the real DB file.
process.env.DB_PATH = ':memory:';

// Pin the protected-account list to the values the admin-routes tests assume.
// Production code reads this from .env (no default), so tests must declare it.
process.env.PROTECTED_ACCOUNT_EMAIL = 'klott@backblaze.com,demo@backblaze.com';
