from agno.workflow import Parallel, Step, Workflow
from ai_api.agents.needs_clarifier import needs_clarifier
from ai_api.agents.query_enhancer import query_enhancer
from ai_api.agents.workflow_designer import workflow_designer
from ai_api.agents.workflow_creator import workflow_creator
from ai_api.agents.workflow_validator import workflow_validator
from ai_api.agents.parameter_detector import parameter_detector

n8n_workflow_creation = Workflow(
    id="n8n-workflow-creation",
    name="N8N workflow creation",
    steps=[
        Step(name="Needs Clarifier", agent=needs_clarifier),
        Step(name="Query Enhancer", agent=query_enhancer),
        Step(name="Workflow Designer", agent=workflow_designer),
        Step(name="Workflow Creator", agent=workflow_creator),
        Step(name="Workflow Validator", agent=workflow_validator),
        Step(name="Parameter Detector", agent=parameter_detector),
    ],
)