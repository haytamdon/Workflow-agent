from agno.db.postgres import PostgresDb
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey, JSON
from sqlalchemy.orm import DeclarativeBase, sessionmaker, relationship
from sqlalchemy.sql import func
import contextlib

from .url import db_url

DB_ID = "agentos-db"


# SQLAlchemy Configuration
from sqlalchemy.pool import StaticPool

connect_args = {}
poolclass = None
if db_url.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
    poolclass = StaticPool

if poolclass:
    engine = create_engine(db_url, connect_args=connect_args, poolclass=poolclass)
else:
    engine = create_engine(db_url)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass

class WorkflowSession(Base):
    __tablename__ = "workflow_sessions"
    
    session_id = Column(String(255), primary_key=True)
    prompt = Column(Text, nullable=False)
    status = Column(String(100), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    
    clarifications = relationship("WorkflowClarification", back_populates="session", cascade="all, delete-orphan")
    steps = relationship("WorkflowStep", back_populates="session", cascade="all, delete-orphan")
    parameters = relationship("WorkflowParameter", back_populates="session", cascade="all, delete-orphan")

class WorkflowClarification(Base):
    __tablename__ = "workflow_clarifications"
    
    clarification_id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(255), ForeignKey("workflow_sessions.session_id", ondelete="CASCADE"), index=True, nullable=False)
    clarification_key = Column(String(255), nullable=False)
    question = Column(Text, nullable=False)
    answer = Column(Text, nullable=True)
    
    session = relationship("WorkflowSession", back_populates="clarifications")

class WorkflowStep(Base):
    __tablename__ = "workflow_steps"
    
    step_id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(255), ForeignKey("workflow_sessions.session_id", ondelete="CASCADE"), index=True, nullable=False)
    agent_name = Column(String(100), nullable=False)
    status = Column(String(50), nullable=False) # 'running', 'completed', 'failed'
    output_text = Column(Text, nullable=True)
    output_json = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    session = relationship("WorkflowSession", back_populates="steps")

class WorkflowParameter(Base):
    __tablename__ = "workflow_parameters"
    
    parameter_id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(255), ForeignKey("workflow_sessions.session_id", ondelete="CASCADE"), index=True, nullable=False)
    missing_parameter_name = Column(String(255), nullable=False)
    question = Column(Text, nullable=False)
    value = Column(Text, nullable=True)
    
    session = relationship("WorkflowSession", back_populates="parameters")


def get_postgres_db(contents_table: str | None = None) -> PostgresDb:
    """Create a PostgresDb instance.

    Pass ``contents_table`` only when this database is the ``contents_db``
    of a Knowledge base — it tells agno where to persist document contents.
    For plain agent persistence (sessions, memory) leave it unset.
    """
    if contents_table is not None:
        return PostgresDb(id=DB_ID, db_url=db_url, knowledge_table=contents_table)
    return PostgresDb(id=DB_ID, db_url=db_url)


def init_db() -> None:
    """Initialize database tables."""
    Base.metadata.create_all(bind=engine)


@contextlib.contextmanager
def get_db_session():
    """Database session context manager."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

