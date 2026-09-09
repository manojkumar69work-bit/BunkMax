import logging
import os
import time
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

# Replace a pooled connection that has been sitting idle longer than this
# instead of handing it out.
#
# psycopg2 keeps at most MIN_CONN connections idle and closes the rest on
# return, so on a quiet app there is effectively ONE long-lived connection that
# nearly every request reuses -- and it is exactly the one Supabase's pooler
# hangs up on for being idle.
IDLE_RECYCLE_SECONDS = max(0, _get_int_env("DB_POOL_MAX_IDLE", 240))

# Verify with a `SELECT 1` before handing out a connection that has been idle
# at least this long. 0 means every connection taken from the idle pool is
# checked; a freshly dialled one never is.
#
# Recycling on age alone is not enough: when the server hangs up, libpq does
# not notice until the next round trip, so `closed` still reads 0 and the
# endpoint's real query is what dies -- which is precisely the error we are
# trying to keep out of the Postgres log. Any trust window, however short, is
# a hole a connection can die inside, so the default buys correctness with one
# round trip per checkout. Raise it if that ever shows up in latency.
PING_AFTER_SECONDS = max(0, _get_int_env("DB_POOL_PING_AFTER", 0))


class _TrackedConnection(extensions.connection):
    """
    A pooled connection that remembers when it was last returned to the pool.

    Keeping the timestamp on the connection itself, rather than in a side map
    keyed by id(), means it goes away with the connection: nothing to prune
    when psycopg2 closes a connection instead of pooling it, and no chance of
    a reused id() pointing at a stale entry.
    """

    idle_since = None


def _mark_returned(raw_conn) -> None:
    raw_conn.idle_since = time.monotonic()


def _mark_in_use(raw_conn) -> None:
    raw_conn.idle_since = None


def _idle_for(raw_conn):
    since = getattr(raw_conn, "idle_since", None)
    return None if since is None else time.monotonic() - since


def _idle_too_long(raw_conn) -> bool:
    if not IDLE_RECYCLE_SECONDS:
        return False

    idle = _idle_for(raw_conn)
    return idle is not None and idle > IDLE_RECYCLE_SECONDS


def _needs_ping(raw_conn) -> bool:
    # No timestamp means the pool just dialled it -- nothing to verify.
    idle = _idle_for(raw_conn)
    return idle is not None and idle >= PING_AFTER_SECONDS


def _ping(raw_conn) -> bool:
    """True if the connection still has a live server on the other end."""
    try:
        with raw_conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()

        # Hand it over idle rather than mid-transaction.
        raw_conn.rollback()
        return True

    except Exception:
        return False


def _discard(raw_conn) -> None:
    """Close a connection and drop it from the pool so getconn() rebuilds it."""
    with suppress(Exception):
        connection_pool.putconn(raw_conn, close=True)


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
            _discard(self._raw_conn)
            return

        try:
            status = self._raw_conn.get_transaction_status()

            if status != extensions.TRANSACTION_STATUS_IDLE:
                self._raw_conn.rollback()

            _mark_returned(self._raw_conn)
            self._pool.putconn(self._raw_conn)

        except Exception:
            logger.exception("Failed to safely return DB connection to pool")
            _discard(self._raw_conn)

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
        connection_factory=_TrackedConnection,
        cursor_factory=RealDictCursor,
    )

    logger.info(
        "Database connection pool created: min=%s max=%s "
        "idle_recycle=%ss ping_after=%ss",
        MIN_CONN,
        MAX_CONN,
        IDLE_RECYCLE_SECONDS,
        PING_AFTER_SECONDS,
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
        # Each discard frees its pool slot, so the next getconn() dials a fresh
        # connection. Bounded so a DB that refuses every connection fails fast
        # instead of spinning.
        for _attempt in range(MAX_CONN + 1):
            raw_conn = connection_pool.getconn()

            if raw_conn.closed or _idle_too_long(raw_conn):
                _discard(raw_conn)
                continue

            if _needs_ping(raw_conn) and not _ping(raw_conn):
                logger.info("Replaced a pooled connection the server had closed")
                _discard(raw_conn)
                continue

            _mark_in_use(raw_conn)
            return PooledConnection(raw_conn, connection_pool)

        raise RuntimeError("No usable connection after recycling the pool")

    except Exception as exc:
        logger.exception("Failed to get connection from pool")
        raise RuntimeError("Database connection failed") from exc


def close_all_connections():
    try:
        connection_pool.closeall()
        logger.info("All database connections closed")

    except Exception:
        logger.exception("Failed to close database connection pool")
