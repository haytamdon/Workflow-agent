from agno.agent import Agent
from ai_api.models import get_model
from ai_api.db import get_postgres_db
from ai_api.prompts.agent_instructions import PARAMETER_DETECTOR_INSTRUCTIONS
from pydantic import BaseModel

class Question(BaseModel):
    """Represents a question to be asked to the user regarding missing information
    Whether that is links of documents or specific parameters such as API keys or custom values."""
    question: str
    missing_parameter_name: str

class QuestionsList(BaseModel):
    """Represents a list of questions to be asked to the user."""
    questions: list[Question]

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
    use_json_mode=True,
    output_schema=QuestionsList
)
