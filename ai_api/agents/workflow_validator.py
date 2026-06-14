from agno.agent import Agent
from ai_api.models import get_model
from ai_api.db import get_postgres_db
from ai_api.prompts.agent_instructions import WORKFLOW_VALIDATOR_INSTRUCTIONS
from agno.skills import Skills, LocalSkills


workflow_validator = Agent(
    id="workflow-validator",
    name="WorkflowValidator",
    model=get_model(),
    db=get_postgres_db(),
    instructions=WORKFLOW_VALIDATOR_INSTRUCTIONS,
    skills=Skills(loaders=[LocalSkills("skills/workflow_validation_skills/")]),
    enable_agentic_memory=True,
    add_datetime_to_context=True,
    add_history_to_context=True,
    num_history_runs=5,
    markdown=True,
)
