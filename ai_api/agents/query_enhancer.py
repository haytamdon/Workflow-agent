from agno.agent import Agent
from ai_api.models import get_model
from ai_api.db import get_postgres_db
from ai_api.prompts.agent_instructions import QUERY_ENHANCER_INSTRUCTIONS


query_enhancer = Agent(
    id="query-enhancer",
    name="QueryEnhancer",
    model=get_model(),
    db=get_postgres_db(),
    instructions=QUERY_ENHANCER_INSTRUCTIONS,
    enable_agentic_memory=True,
    add_datetime_to_context=True,
    add_history_to_context=True,
    num_history_runs=5,
    markdown=True,
)