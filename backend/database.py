import os
import logging
from pathlib import Path
from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import QueuePool

# ---------------------------
# 1. LOAD ENVIRONMENT
# ---------------------------
# This ensures the .env file is found even if uvicorn is started from a different folder
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)

logger = logging.getLogger("database")

# ---------------------------
# 2. DATABASE URL SETUP
# ---------------------------
DATABASE_URL = os.getenv("DATABASE_URL", "")

if not DATABASE_URL:
    # This will help you debug if the .env isn't being read
    print(f"CRITICAL: No DATABASE_URL found. Checked at: {env_path}")
    raise RuntimeError("DATABASE_URL environment variable is missing")

# SQLAlchemy Async requires 'postgresql+asyncpg' or 'postgresql+asyncpg'
# We fix the common Supabase/Render 'postgres://' or 'postgresql://' prefixes here
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://") and "+asyncpg" not in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# ---------------------------
# 3. ASYNC ENGINE CONFIG
# ---------------------------
engine = create_async_engine(
    DATABASE_URL,
    # Removed pool_class=QueuePool to fix the TypeError
    pool_size=10,         
    max_overflow=5,       
    pool_timeout=30,      
    pool_recycle=1800,    
    pool_pre_ping=True,   
    echo=False            
)

# ---------------------------
# 4. SESSION FACTORY
# ---------------------------
async_session = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False
)

# ---------------------------
# 5. FASTAPI DEPENDENCY
# ---------------------------
async def get_db():
    """
    Dependency to be used in FastAPI routes.
    Example: 
    @app.get("/")
    async def index(db: AsyncSession = Depends(get_db)):
        ...
    """
    async with async_session() as session:
        try:
            yield session
        except Exception as e:
            logger.error(f"Database session error: {e}")
            await session.rollback()
            raise
        finally:
            await session.close()