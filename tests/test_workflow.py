import os
import json
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

# Mock environment variables before imports
os.environ["DB_DRIVER"] = "sqlite"
os.environ["DB_USER"] = ""
os.environ["DB_PASS"] = ""
os.environ["DB_HOST"] = ""
os.environ["DB_PORT"] = ""
os.environ["DB_DATABASE"] = ":memory:"
os.environ["MODEL_PROVIDER"] = "openrouter"

from ai_api.main import app
from ai_api.db.session import (
    Base,
    engine,
    get_db_session,
    WorkflowSession,
    WorkflowClarification,
    WorkflowStep,
    WorkflowParameter
)
from ai_api.agents.needs_clarifier import ClarificationQuestionsList, ClarificationQuestion
from ai_api.agents.parameter_detector import QuestionsList, Question


@pytest.fixture(autouse=True)
def setup_db():
    """Create a clean sqlite database for each test, deleting it afterwards."""
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)



@pytest.fixture
def client():
    """Yield test client inside a lifespan context to trigger FastAPI startup event."""
    with TestClient(app) as test_client:
        yield test_client


def test_init_db():
    """Verify that database tables are initialized properly."""
    with get_db_session() as db:
        # Tables should be empty but exist
        sessions = db.query(WorkflowSession).all()
        assert len(sessions) == 0


@patch("ai_api.workflow.workflow.needs_clarifier")
def test_workflow_needs_clarification(mock_needs_clarifier, client):
    """Test that workflow halts and asks clarification questions if needed."""
    # Configure mock needs_clarifier response
    mock_response = MagicMock()
    mock_response.content = ClarificationQuestionsList(
        questions=[
            ClarificationQuestion(
                id="q1",
                question="What slack channel do you want to post notifications to?",
                clarification_key="slack_channel"
            )
        ]
    )
    mock_needs_clarifier.run.return_value = mock_response

    # Call run API
    response = client.post(
        "/workflows/n8n-workflow-creation/runs",
        data={
            "message": "Create a webhook to Slack",
            "session_id": "test-session-1",
            "stream": "false"
        }
    )
    assert response.status_code == 200
    
    # Assert questions returned in output stream
    stream_output = response.text
    assert "slack_channel" in stream_output
    assert "What slack channel" in stream_output

    # Check database state
    with get_db_session() as db:
        session = db.query(WorkflowSession).filter_by(session_id="test-session-1").first()
        assert session is not None
        assert session.status == "needs_clarification"

        # Verify clarification question saved
        clars = db.query(WorkflowClarification).filter_by(session_id="test-session-1").all()
        assert len(clars) == 1
        assert clars[0].clarification_key == "slack_channel"
        assert clars[0].answer is None


@patch("ai_api.workflow.workflow.needs_clarifier")
@patch("ai_api.workflow.workflow.query_enhancer")
@patch("ai_api.workflow.workflow.workflow_designer")
@patch("ai_api.workflow.workflow.workflow_creator")
@patch("ai_api.workflow.workflow.workflow_validator")
@patch("ai_api.workflow.workflow.parameter_detector")
def test_workflow_full_pipeline_to_parameters(
    mock_detector, mock_validator, mock_creator, mock_designer, mock_enhancer, mock_needs_clarifier, client
):
    """Test full pipeline running sequentially and halting at missing parameters stage."""
    # 1. No clarifications needed
    mock_nc_res = MagicMock()
    mock_nc_res.content = ClarificationQuestionsList(questions=[])
    mock_needs_clarifier.run.return_value = mock_nc_res

    # 2. Query Enhancer response
    mock_qe_res = MagicMock()
    mock_qe_res.content = "Enhanced query details"
    mock_enhancer.run.return_value = mock_qe_res

    # 3. Workflow Designer response
    mock_wd_res = MagicMock()
    mock_wd_res.content = "Workflow design description"
    mock_designer.run.return_value = mock_wd_res

    # 4. Workflow Creator response (draft JSON)
    mock_wc_res = MagicMock()
    mock_wc_res.content = json.dumps({
        "nodes": [
            {
                "parameters": {"url": "https://api.example.com"},
                "id": "node-1",
                "name": "HTTP Request",
                "type": "nodes-base.httpRequest"
            }
        ],
        "connections": {}
    })
    mock_creator.run.return_value = mock_wc_res

    # 5. Workflow Validator response
    mock_wv_res = MagicMock()
    mock_wv_res.content = "Validation Report: All good, but missing Slack Auth credentials."
    mock_validator.run.return_value = mock_wv_res

    # 6. Parameter Detector response
    mock_pd_res = MagicMock()
    mock_pd_res.content = QuestionsList(
        questions=[
            Question(
                question="What is the Slack API token?",
                missing_parameter_name="slack_token"
            )
        ]
    )
    mock_detector.run.return_value = mock_pd_res

    # Run API
    response = client.post(
        "/workflows/n8n-workflow-creation/runs",
        data={
            "message": "Create a HTTP webhook",
            "session_id": "test-session-2",
            "stream": "false"
        }
    )
    assert response.status_code == 200

    # Assert parameter questions yielded
    stream_output = response.text
    assert "slack_token" in stream_output

    # Check database states and steps logged
    with get_db_session() as db:
        session = db.query(WorkflowSession).filter_by(session_id="test-session-2").first()
        assert session.status == "needs_parameters"

        # Verify steps logged
        steps = db.query(WorkflowStep).filter_by(session_id="test-session-2").all()
        assert len(steps) == 6  # needs_clarifier, query_enhancer, workflow_designer, workflow_creator, workflow_validator, parameter_detector
        
        step_names = [s.agent_name for s in steps]
        assert "query_enhancer" in step_names
        assert "workflow_designer" in step_names
        assert "workflow_creator" in step_names
        assert "workflow_validator" in step_names

        # Verify parameter questions saved in DB
        params = db.query(WorkflowParameter).filter_by(session_id="test-session-2").all()
        assert len(params) == 1
        assert params[0].missing_parameter_name == "slack_token"
        assert params[0].value is None


@patch("ai_api.workflow.workflow.workflow_creator")
def test_workflow_parameter_injection(mock_creator, client):
    """Test submitting parameter answers to final workflow creator rerun."""
    # Pre-seed session in DB waiting for parameters
    with get_db_session() as db:
        session = WorkflowSession(
            session_id="test-session-3",
            prompt="HTTP sync",
            status="needs_parameters"
        )
        db.add(session)
        
        # Pre-seed draft HTTP creator step
        draft_json = {
            "nodes": [
                {
                    "parameters": {"url": "https://api.example.com", "token": "PLACEHOLDER"},
                    "id": "node-1",
                    "name": "HTTP Request"
                }
            ],
            "connections": {}
        }
        db.add(WorkflowStep(
            session_id="test-session-3",
            agent_name="workflow_creator",
            status="completed",
            output_json=draft_json
        ))
        
        # Pre-seed missing parameter question
        db.add(WorkflowParameter(
            session_id="test-session-3",
            missing_parameter_name="slack_token",
            question="What is the Slack API token?"
        ))
        db.commit()

    # Configure final creator response with updated JSON
    mock_wc_res = MagicMock()
    mock_wc_res.content = json.dumps({
        "nodes": [
            {
                "parameters": {"url": "https://api.example.com", "token": "my-secret-token-123"},
                "id": "node-1",
                "name": "HTTP Request"
            }
        ],
        "connections": {}
    })
    mock_creator.run.return_value = mock_wc_res

    # Call run API with parameter answers
    response = client.post(
        "/workflows/n8n-workflow-creation/runs",
        data={
            "message": "HTTP sync",
            "session_id": "test-session-3",
            "answers": json.dumps({"slack_token": "my-secret-token-123"})
        }
    )
    assert response.status_code == 200
    
    # Assert final JSON yielded
    stream_output = response.text
    assert "my-secret-token-123" in stream_output

    # Check database updates
    with get_db_session() as db:
        session = db.query(WorkflowSession).filter_by(session_id="test-session-3").first()
        assert session.status == "final_workflow_completed"

        # Verify parameter answer saved
        param = db.query(WorkflowParameter).filter_by(session_id="test-session-3", missing_parameter_name="slack_token").first()
        assert param.value == "my-secret-token-123"

        # Verify final step logged
        final_step = db.query(WorkflowStep).filter_by(session_id="test-session-3", agent_name="final_workflow_creator").first()
        assert final_step is not None
        assert final_step.output_json["nodes"][0]["parameters"]["token"] == "my-secret-token-123"


def test_logs_endpoint(client):
    """Test retrieving session execution logs via GET endpoint."""
    with get_db_session() as db:
        # Pre-seed session
        db.add(WorkflowSession(session_id="session-logs-test", prompt="query", status="completed"))
        # Pre-seed steps
        db.add(WorkflowStep(session_id="session-logs-test", agent_name="needs_clarifier", status="completed", output_text="No questions"))
        db.add(WorkflowStep(session_id="session-logs-test", agent_name="query_enhancer", status="running"))
        db.commit()

    response = client.get("/workflows/session-logs-test/logs")
    assert response.status_code == 200
    
    logs = response.json()
    assert len(logs) == 2
    assert logs[0]["agent_name"] == "needs_clarifier"
    assert logs[0]["status"] == "completed"
    assert logs[0]["output_text"] == "No questions"
    assert logs[1]["agent_name"] == "query_enhancer"
    assert logs[1]["status"] == "running"
