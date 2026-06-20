"""
Workflow API Entrypoint
======================
"""

from fastapi import FastAPI, Form, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from agno.utils.log import log_info
import os
import json
import threading
from ai_api.db.seed import seed_n8n_database
from ai_api.db.session import init_db
from n8n_api.n8n import router as n8n_router

runtime_env = os.getenv("RUNTIME_ENV", "prd")

# Lifespan — startup / teardown hook.
@asynccontextmanager
async def lifespan(app: FastAPI):
    log_info("Workflow API lifespan: startup")
    try:
        init_db()
        log_info("SQLAlchemy database tables initialized.")
    except Exception as e:
        log_info(f"Database initialization failed: {e}")

    threading.Thread(target=seed_n8n_database, daemon=True).start()
    try:
        yield
    finally:
        log_info("Workflow API lifespan: shutdown")


app = FastAPI(
    title="Workflow API",
    version="1.0.0",
    lifespan=lifespan
)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(n8n_router)


@app.post("/workflows/{workflow_id}/runs")
async def run_workflow_endpoint(
    workflow_id: str,
    message: str = Form(...),
    session_id: str = Form(...),
    user_id: str = Form(None),
    stream: bool = Form(True),
    answers: str = Form(None),
):
    """Run the multi-agent workflow statefully and stream progress using SSE."""
    answers_dict = {}
    if answers:
        try:
            answers_dict = json.loads(answers)
        except Exception:
            pass

    from ai_api.workflow.workflow import execute_workflow_step

    return StreamingResponse(
        execute_workflow_step(session_id, message, answers_dict),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@app.get("/workflows/{session_id}/logs")
async def get_workflow_logs(session_id: str):
    """Fetch database execution logs for a specific session."""
    from ai_api.db.session import get_db_session, WorkflowStep
    with get_db_session() as db:
        steps = db.query(WorkflowStep).filter_by(session_id=session_id).order_by(WorkflowStep.created_at.asc()).all()
        return [
            {
                "agent_name": step.agent_name,
                "status": step.status,
                "output_text": step.output_text,
                "output_json": step.output_json,
                "created_at": step.created_at.isoformat() if step.created_at else None
            }
            for step in steps
        ]


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("ai_api.main:app", host="0.0.0.0", port=8000, reload=runtime_env == "dev")
