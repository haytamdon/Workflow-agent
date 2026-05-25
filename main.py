"""
AgentOS Entrypoint
==================
"""

from workflow.workflow import n8n_workflow_creation
from agno.os import AgentOS
from agno.utils.log import log_info
import os
from contextlib import asynccontextmanager
from pathlib import Path
from db.session import get_postgres_db

runtime_env = os.getenv("RUNTIME_ENV", "prd")
scheduler_base_url = os.getenv("AGENTOS_URL", "http://127.0.0.1:8000")

# ---------------------------------------------------------------------------
# Lifespan — extension hook for app-level startup / teardown.
#
# AgentOS handles the MCP lifecycle (connect on startup, close on shutdown).
# Keep this hook in place so you can plug in your own setup as needed.
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app):  # type: ignore[no-untyped-def]
    log_info("AgentOS lifespan: startup")
    try:
        yield
    finally:
        log_info("AgentOS lifespan: shutdown")

agent_os = AgentOS(
    name="AgentOS",
    tracing=True,
    authorization=runtime_env == "prd",
    lifespan=lifespan,
    db=get_postgres_db(),
    workflows=[n8n_workflow_creation],
    # agents=[],
    config=str(Path(__file__).parent / "config.yaml"),
)

app = agent_os.get_app()

if __name__ == "__main__":
    agent_os.serve(app="app.main:app", reload=runtime_env == "dev", port=8000)