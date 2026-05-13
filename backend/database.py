import logging
import os
from contextlib import suppress

import psycopg2
from dotenv import load_dotenv
from psycopg2 import extensions
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool

load_dotenv()

logger = logging.getLogger("database")

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is missing")


def _get_int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        logger.warning("Invalid %s value. Falling back to %s.", name, default)
        return default


MIN_CONN = max(1, _get_int_env("DB_POOL_MIN", 1))
MAX_CONN = max(MIN_CONN, _get_int_env("DB_POOL_MAX", 5))


class PooledConnection:
    """
    Small wrapper around a psycopg2 pooled connection.

    Existing code can still do:

        conn = get_conn()
        ...
        conn.close()

    Calling close() returns the connection to the pool instead of closing it.
    """

    def __init__(self, raw_conn, pool: ThreadedConnectionPool):
        self._raw_conn = raw_conn
        self._pool = pool
        self._returned = False

    def cursor(self, *args, **kwargs):
        if "cursor_factory" not in kwargs:
            kwargs["cursor_factory"] = RealDictCursor
        return self._raw_conn.cursor(*args, **kwargs)

    def commit(self):
        return self._raw_conn.commit()

    def rollback(self):
        return self._raw_conn.rollback()

    def close(self):
        if self._returned:
            return

        self._returned = True

        if self._raw_conn.closed:
            with suppress(Exception):
                self._pool.putconn(self._raw_conn, close=True)
            return

        try:
            status = self._raw_conn.get_transaction_status()

            if status != extensions.TRANSACTION_STATUS_IDLE:
                self._raw_conn.rollback()

            self._pool.putconn(self._raw_conn)

        except Exception:
            logger.exception("Failed to safely return DB connection to pool")

            with suppress(Exception):
                self._pool.putconn(self._raw_conn, close=True)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is not None:
            with suppress(Exception):
                self.rollback()

        self.close()

    def __getattr__(self, name):
        return getattr(self._raw_conn, name)


try:
    connection_pool = ThreadedConnectionPool(
        MIN_CONN,
        MAX_CONN,
        dsn=DATABASE_URL,
        cursor_factory=RealDictCursor,
    )

    logger.info(
        "Database connection pool created: min=%s max=%s",
        MIN_CONN,
        MAX_CONN,
    )

except Exception as exc:
    logger.exception("Failed to create database connection pool")
    raise RuntimeError("Failed to create database connection pool") from exc


def get_conn() -> PooledConnection:
    """
    Get a database connection from the pool.

    Always call conn.close() when done.
    The wrapper returns it to the pool.
    """

    try:
        raw_conn = connection_pool.getconn()

        if raw_conn.closed:
            with suppress(Exception):
                connection_pool.putconn(raw_conn, close=True)

            raw_conn = connection_pool.getconn()

        return PooledConnection(raw_conn, connection_pool)

    except Exception as exc:
        logger.exception("Failed to get connection from pool")
        raise RuntimeError("Database connection failed") from exc


def close_all_connections():
    try:
        connection_pool.closeall()
        logger.info("All database connections closed")

    except Exception:
        logger.exception("Failed to close database connection pool")
