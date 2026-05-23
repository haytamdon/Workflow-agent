"""
Database URL
============
"""

import os
from urllib.parse import quote


def build_db_url() -> str:
    """Build database URL from environment variables."""
    driver = os.getenv("DB_DRIVER")
    user = os.getenv("DB_USER")
    password = quote(os.getenv("DB_PASS"), safe="")
    host = os.getenv("DB_HOST")
    port = os.getenv("DB_PORT")
    database = os.getenv("DB_DATABASE")

    return f"{driver}://{user}:{password}@{host}:{port}/{database}"


db_url = build_db_url()
