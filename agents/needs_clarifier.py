from agno.agent import Agent
from models import get_model
from db import get_postgres_db
from prompts.agent_instructions import NEEDS_CLARIFIER_INSTRUCTIONS
from pydantic import BaseModel

class ClarificationQuestion(BaseModel):
    """Represents a question to be asked to the user regarding extra clarifications to understand their needs better."""
    id: str
    question: str
    clarification_key: str

class ClarificationQuestionsList(BaseModel):
    """Represents a list of clarification questions to be asked to the user."""
    questions: list[ClarificationQuestion]

needs_clarifier = Agent(
    id="needs-clarifier",
    name="NeedsClarifier",
    model=get_model(),
    db=get_postgres_db(),
    instructions=NEEDS_CLARIFIER_INSTRUCTIONS,
    enable_agentic_memory=True,
    add_datetime_to_context=True,
    add_history_to_context=True,
    num_history_runs=5,
    use_json_mode=True,
    output_schema=ClarificationQuestionsList
)
