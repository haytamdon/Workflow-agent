"""Server-side n8n API helpers.

The frontend can request workflow creation without receiving the n8n API key.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field


router = APIRouter(prefix="/api/n8n", tags=["n8n"])

PLACEHOLDER_API_KEYS = {
    "",
    "replace-with-the-api-key-created-in-n8n",
    "change-me",
    "changeme",
}


class N8NStatusResponse(BaseModel):
    configured: bool
    editor_url: str


class N8NWorkflowCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=128)
    workflow: dict[str, Any]
    activate: bool = False


class N8NWorkflowCreateResponse(BaseModel):
    id: str
    name: str
    url: str
    active: bool = False


def _clean_url(value: str) -> str:
    return value.strip().rstrip("/")


def get_n8n_editor_url() -> str:
    return _clean_url(
        os.getenv("N8N_EDITOR_BASE_URL")
        or os.getenv("N8N_BASE_URL")
        or "http://localhost:5678"
    )


def get_n8n_api_url() -> str:
    configured_api_url = os.getenv("N8N_API_URL")
    if configured_api_url:
        return _clean_url(configured_api_url)
    return f"{get_n8n_editor_url()}/api/v1"


def get_n8n_api_key() -> str:
    return os.getenv("N8N_API_KEY", "").strip()


def is_n8n_configured(api_key: str | None = None) -> bool:
    candidate = (api_key if api_key is not None else get_n8n_api_key()).strip()
    return candidate.lower() not in PLACEHOLDER_API_KEYS


def build_workflow_editor_url(workflow_id: str) -> str:
    return f"{get_n8n_editor_url()}/workflow/{workflow_id}"


def build_n8n_create_payload(name: str, workflow: dict[str, Any]) -> dict[str, Any]:
    nodes = workflow.get("nodes")
    connections = workflow.get("connections")

    if not isinstance(nodes, list) or not nodes:
        raise HTTPException(
            status_code=400,
            detail="workflow.nodes must be a non-empty array",
        )
    if not isinstance(connections, dict):
        raise HTTPException(
            status_code=400,
            detail="workflow.connections must be an object",
        )

    payload: dict[str, Any] = {
        "name": name.strip(),
        "nodes": nodes,
        "connections": connections,
    }

    settings = workflow.get("settings")
    payload["settings"] = settings if isinstance(settings, dict) else {"executionOrder": "v1"}

    for optional_key in ("staticData", "tags", "projectId", "meta"):
        if optional_key in workflow:
            payload[optional_key] = workflow[optional_key]

    return payload


def _safe_response_detail(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return response.text[:1200]


@router.get("/status", response_model=N8NStatusResponse)
async def get_n8n_status() -> N8NStatusResponse:
    return N8NStatusResponse(
        configured=is_n8n_configured(),
        editor_url=get_n8n_editor_url(),
    )


@router.post("/workflows", response_model=N8NWorkflowCreateResponse)
async def create_n8n_workflow(
    request: N8NWorkflowCreateRequest,
) -> N8NWorkflowCreateResponse:
    api_key = get_n8n_api_key()
    if not is_n8n_configured(api_key):
        raise HTTPException(
            status_code=503,
            detail="N8N_API_KEY is not configured on the backend",
        )

    payload = build_n8n_create_payload(request.name, request.workflow)
    headers = {
        "X-N8N-API-KEY": api_key,
        "Content-Type": "application/json",
    }
    api_url = get_n8n_api_url()

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            create_response = await client.post(
                f"{api_url}/workflows",
                headers=headers,
                json=payload,
            )
            if create_response.status_code >= 400:
                raise HTTPException(
                    status_code=502,
                    detail={
                        "message": "n8n rejected the workflow create request",
                        "n8n_status_code": create_response.status_code,
                        "n8n_response": _safe_response_detail(create_response),
                    },
                )

            created = create_response.json()
            workflow_id = str(created.get("id") or "")
            if not workflow_id:
                raise HTTPException(
                    status_code=502,
                    detail={
                        "message": "n8n created a workflow response without an id",
                        "n8n_response": created,
                    },
                )

            active = bool(created.get("active", False))
            if request.activate:
                activate_response = await client.post(
                    f"{api_url}/workflows/{workflow_id}/activate",
                    headers=headers,
                    json={},
                )
                if activate_response.status_code >= 400:
                    raise HTTPException(
                        status_code=502,
                        detail={
                            "message": "Workflow was created but n8n rejected activation",
                            "id": workflow_id,
                            "url": build_workflow_editor_url(workflow_id),
                            "n8n_status_code": activate_response.status_code,
                            "n8n_response": _safe_response_detail(activate_response),
                        },
                    )
                if activate_response.content:
                    activated = activate_response.json()
                    active = bool(activated.get("active", True))
                else:
                    active = True

    except HTTPException:
        raise
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach n8n at {api_url}: {exc.__class__.__name__}",
        ) from exc

    return N8NWorkflowCreateResponse(
        id=workflow_id,
        name=str(created.get("name") or request.name),
        url=build_workflow_editor_url(workflow_id),
        active=active,
    )
