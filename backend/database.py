import os
import psycopg2
import psycopg2.extras
from psycopg2 import pool
from dotenv import load_dotenv
import logging

# Setup logging
logger = logging.getLogger(__name__)

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise Exception(
        "DATABASE_URL environment variable is not set. "
        "Please set it in your .env file or environment."
    )

# Create connection pool for better performance
try:
    connection_pool = pool.SimpleConnectionPool(
        1,      # minconn - minimum connections
        20,     # maxconn - maximum connections (adjust based on needs)
        DATABASE_URL,
        cursor_factory=psycopg2.extras.RealDictCursor,
        sslmode="require"
    )
    logger.info("Database connection pool initialized")
except Exception as e:
    logger.error(f"Failed to create connection pool: {e}")
    raise Exception(f"Database connection pool initialization failed: {e}")


def get_conn():
    """
    Get a connection from the pool.
    Compatible with existing code that calls get_conn().
    """
    try:
        conn = connection_pool.getconn()
        if conn is None:
            raise Exception("No available connections in pool")
        return conn
    except Exception as e:
        logger.error(f"Failed to get connection from pool: {e}")
        raise Exception(f"Database connection failed: {e}")


def return_conn(conn):
    """
    Return a connection to the pool after use.
    Optional - useful for explicit cleanup.
    """
    if conn:
        try:
            connection_pool.putconn(conn)
        except Exception as e:
            logger.error(f"Failed to return connection to pool: {e}")


def close_pool():
    """
    Close all connections in the pool.
    Call this on application shutdown.
    """
    if connection_pool:
        try:
            connection_pool.closeall()
            logger.info("Database connection pool closed")
        except Exception as e:
            logger.error(f"Failed to close connection pool: {e}")