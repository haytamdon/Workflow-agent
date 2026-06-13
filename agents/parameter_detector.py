from agno.agent import Agent
from models import get_model
from db import get_postgres_db
from prompts.agent_instructions import PARAMETER_DETECTOR_INSTRUCTIONS


parameter_detector = Agent(
    id="parameter-detector",
    name="ParameterDetector",
    model=get_model(),
    db=get_postgres_db(),
    instructions=PARAMETER_DETECTOR_INSTRUCTIONS,
    enable_agentic_memory=True,
    add_datetime_to_context=True,
    add_history_to_context=True,
    num_history_runs=5,
    markdown=True,
)
