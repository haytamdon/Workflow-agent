import { buildAuthHeaders, normalizeBaseUrl } from "./workflow_api";
import type { N8nWorkflow } from "./results";


export interface N8nStatus {
  configured: boolean;
  editor_url: string;
}

export interface CreatedN8nWorkflow {
  id: string;
  name: string;
  url: string;
  active: boolean;
}

export interface CreateWorkflowState {
  disabled: boolean;
  reason: string;
}

export async function getN8nStatus(
  agentosBaseUrl: string,
  token?: string,
): Promise<N8nStatus> {
  const response = await fetch(`${normalizeBaseUrl(agentosBaseUrl)}/api/n8n/status`, {
    headers: buildAuthHeaders(token),
  });

  if (!response.ok) {
    throw new Error(`Could not read n8n status: ${response.status}`);
  }

  return response.json() as Promise<N8nStatus>;
}

export async function createWorkflowInN8n(input: {
  agentosBaseUrl: string;
  token?: string;
  name: string;
  workflow: N8nWorkflow;
  activate: boolean;
}): Promise<CreatedN8nWorkflow> {
  const response = await fetch(
    `${normalizeBaseUrl(input.agentosBaseUrl)}/api/n8n/workflows`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(input.token),
      },
      body: JSON.stringify({
        name: input.name,
        workflow: input.workflow,
        activate: input.activate,
      }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `n8n create request failed with ${response.status}`);
  }

  return response.json() as Promise<CreatedN8nWorkflow>;
}

export function getCreateWorkflowState(
  status: N8nStatus | null,
  workflow: N8nWorkflow | null,
  isCreating: boolean,
): CreateWorkflowState {
  if (isCreating) {
    return { disabled: true, reason: "Creating workflow" };
  }
  if (!workflow) {
    return { disabled: true, reason: "Generate workflow JSON first" };
  }
  if (!status?.configured) {
    return { disabled: true, reason: "N8N_API_KEY is not configured" };
  }
  return { disabled: false, reason: "Create workflow in n8n" };
}
