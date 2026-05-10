import os
import logging
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool

logger = logging.getLogger("database")

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is missing")


class PooledConnection:
    """
    Wrapper around a psycopg2 pooled connection.

    This allows existing code like:
        conn = get_conn()
        ...
        conn.close()

    to keep working, while internally returning the connection
    back to the pool instead of actually closing it.
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

        try:
            if not self._raw_conn.closed:
                self._pool.putconn(self._raw_conn)
        except Exception as e:
            logger.exception("Failed to return connection to pool: %s", e)
        finally:
            self._returned = True

    def __getattr__(self, name):
        return getattr(self._raw_conn, name)


# Keep pool small for Render/free DBs.
# Too large can exhaust PostgreSQL plan limits.
MIN_CONN = int(os.getenv("DB_POOL_MIN", "1"))
MAX_CONN = int(os.getenv("DB_POOL_MAX", "5"))

try:
    connection_pool = ThreadedConnectionPool(
        MIN_CONN,
        MAX_CONN,
        dsn=DATABASE_URL,
        cursor_factory=RealDictCursor,
    )
    logger.info("Database connection pool created: min=%s max=%s", MIN_CONN, MAX_CONN)
except Exception as e:
    logger.exception("Failed to create database connection pool")
    raise RuntimeError(f"Failed to create database connection pool: {e}")


def get_conn():
    """
    Get a database connection from the pool.

    IMPORTANT:
    Call conn.close() when done.
    This wrapper returns it to the pool.
    """
    try:
        raw_conn = connection_pool.getconn()

        if raw_conn.closed:
            raw_conn = psycopg2.connect(
                DATABASE_URL,
                cursor_factory=RealDictCursor,
            )

        return PooledConnection(raw_conn, connection_pool)

    except Exception as e:
        logger.exception("Failed to get connection from pool")
        raise Exception(f"Database connection failed: {e}")


def close_all_connections():
    try:
        connection_pool.closeall()
        logger.info("All database connections closed")
    except Exception as e:
        logger.exception("Failed to close database connection pool: %s", e)