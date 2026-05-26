// Use in-memory SQLite for all server tests — avoids touching the real DB file.
process.env.DB_PATH = ':memory:';
