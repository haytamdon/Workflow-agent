"""
Database Session
================

PostgreSQL connection helpers.
``get_postgres_db()`` for agent storage backed by Postgres.
"""

from agno.db.postgres import PostgresDb

from .url import db_url

DB_ID = "agentos-db"


def get_postgres_db(contents_table: str | None = None) -> PostgresDb:
    """Create a PostgresDb instance.

    Pass ``contents_table`` only when this database is the ``contents_db``
    of a Knowledge base — it tells agno where to persist document contents.
    For plain agent persistence (sessions, memory) leave it unset.
    """
    if contents_table is not None:
        return PostgresDb(id=DB_ID, db_url=db_url, knowledge_table=contents_table)
    return PostgresDb(id=DB_ID, db_url=db_url)
