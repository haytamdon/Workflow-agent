export const WORKFLOW_ID = "n8n-workflow-creation";

export interface WorkflowRunEvent {
  type: string;
  data: unknown;
  text: string;
  raw: string;
}

export interface WorkflowRunResponse {
  payload: unknown;
  rawText: string;
  events: WorkflowRunEvent[];
}

export interface WorkflowRunInput {
  agentosBaseUrl: string;
  message: string;
  userId?: string;
  sessionId?: string;
  token?: string;
  stream?: boolean;
  signal?: AbortSignal;
  answers?: Record<string, string>;
  onEvent?: (event: WorkflowRunEvent) => void;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || "http://localhost:8000").trim().replace(/\/+$/, "");
}

export function buildWorkflowRunUrl(
  baseUrl: string,
  workflowId = WORKFLOW_ID,
): string {
  return `${normalizeBaseUrl(baseUrl)}/workflows/${encodeURIComponent(workflowId)}/runs`;
}

export function buildAuthHeaders(token?: string): HeadersInit {
  const cleanToken = token?.trim();
  return cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {};
}

export function buildWorkflowRunForm(input: {
  message: string;
  userId?: string;
  sessionId?: string;
  stream?: boolean;
  answers?: Record<string, string>;
}): FormData {
  const form = new FormData();
  form.append("message", input.message);
  form.append("stream", String(input.stream ?? true));

  if (input.userId?.trim()) {
    form.append("user_id", input.userId.trim());
  }
  if (input.sessionId?.trim()) {
    form.append("session_id", input.sessionId.trim());
  }
  if (input.answers) {
    form.append("answers", JSON.stringify(input.answers));
  }

  return form;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractTextFromPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload === null || payload === undefined) {
    return "";
  }
  if (Array.isArray(payload)) {
    return payload.map(extractTextFromPayload).filter(Boolean).join("\n");
  }

  const record = asRecord(payload);
  if (record) {
    for (const key of [
      "content",
      "delta",
      "response",
      "message",
      "text",
      "output",
      "result",
      "data",
    ]) {
      const text = extractTextFromPayload(record[key]);
      if (text) {
        return text;
      }
    }
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function parseSseMessage(block: string): WorkflowRunEvent | null {
  const lines = block.split(/\r?\n/);
  const eventLine = lines.find((line) => line.startsWith("event:"));
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (!dataLines.length) {
    return null;
  }

  const rawData = dataLines.join("\n");
  const type = eventLine?.slice(6).trim() || "message";

  if (rawData === "[DONE]") {
    return { type: "done", data: null, text: "", raw: block };
  }

  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    data = rawData;
  }

  return {
    type,
    data,
    text: extractTextFromPayload(data),
    raw: block,
  };
}

async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent?: (event: WorkflowRunEvent) => void,
): Promise<WorkflowRunResponse> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: WorkflowRunEvent[] = [];
  let buffer = "";
  let rawText = "";
  let payload: unknown = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const event = parseSseMessage(block.trim());
      if (!event) {
        continue;
      }

      events.push(event);
      payload = event.data;
      if (event.text) {
        rawText = rawText ? `${rawText}\n${event.text}` : event.text;
      }
      onEvent?.(event);
    }
  }

  const finalBlock = buffer.trim();
  if (finalBlock) {
    const event = parseSseMessage(finalBlock);
    if (event) {
      events.push(event);
      payload = event.data;
      rawText = event.text ? `${rawText}\n${event.text}`.trim() : rawText;
      onEvent?.(event);
    }
  }

  return { payload, rawText, events };
}

export async function runWorkflow(
  input: WorkflowRunInput,
): Promise<WorkflowRunResponse> {
  const response = await fetch(buildWorkflowRunUrl(input.agentosBaseUrl), {
    method: "POST",
    headers: buildAuthHeaders(input.token),
    body: buildWorkflowRunForm({
      message: input.message,
      userId: input.userId,
      sessionId: input.sessionId,
      stream: input.stream ?? true,
      answers: input.answers,
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed with ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (response.body && contentType.includes("text/event-stream")) {
    return readSseStream(response.body, input.onEvent);
  }

  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  const rawText = extractTextFromPayload(payload);
  const event: WorkflowRunEvent = {
    type: "response",
    data: payload,
    text: rawText,
    raw: text,
  };
  input.onEvent?.(event);

  return {
    payload,
    rawText,
    events: [event],
  };
}

export async function getWorkflowLogs(
  baseUrl: string,
  sessionId: string,
  token?: string,
): Promise<any[]> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/workflows/${encodeURIComponent(sessionId)}/logs`, {
    method: "GET",
    headers: buildAuthHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch workflow logs: ${response.statusText}`);
  }
  return response.json();
}
