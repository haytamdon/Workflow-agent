export interface N8nWorkflow {
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkflowExtraction {
  workflow: N8nWorkflow | null;
  formattedJson: string;
  source: "direct" | "fenced" | "embedded" | "nested" | "none";
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isN8nWorkflow(value: unknown): value is N8nWorkflow {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value.nodes) && isRecord(value.connections);
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findWorkflowInValue(
  value: unknown,
  seen = new WeakSet<object>(),
): N8nWorkflow | null {
  if (isN8nWorkflow(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const workflow = findWorkflowInValue(item, seen);
      if (workflow) {
        return workflow;
      }
    }
  }
  if (isRecord(value)) {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);
    for (const item of Object.values(value)) {
      const workflow = findWorkflowInValue(item, seen);
      if (workflow) {
        return workflow;
      }
    }
  }
  return null;
}

export function findJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates.sort((left, right) => right.length - left.length);
}

function parseCandidate(candidate: string): N8nWorkflow | null {
  try {
    const parsed = JSON.parse(candidate);
    return findWorkflowInValue(parsed);
  } catch {
    return null;
  }
}

export function extractWorkflowJson(input: unknown): WorkflowExtraction {
  const nested = typeof input === "string" ? null : findWorkflowInValue(input);
  if (nested) {
    return {
      workflow: nested,
      formattedJson: JSON.stringify(nested, null, 2),
      source: typeof input === "string" ? "embedded" : "nested",
    };
  }

  const text = stringify(input);
  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1].trim(),
  );

  for (const block of fencedBlocks) {
    const workflow = parseCandidate(block);
    if (workflow) {
      return {
        workflow,
        formattedJson: JSON.stringify(workflow, null, 2),
        source: "fenced",
      };
    }
  }

  for (const candidate of findJsonObjectCandidates(text)) {
    const workflow = parseCandidate(candidate);
    if (workflow) {
      return {
        workflow,
        formattedJson: JSON.stringify(workflow, null, 2),
        source: "embedded",
      };
    }
  }

  return {
    workflow: null,
    formattedJson: "",
    source: "none",
    error: "No importable n8n workflow JSON was found in the run output.",
  };
}

export function extractAuditMarkdown(input: unknown): string {
  const text = stringify(input).trim();
  if (!text) {
    return "";
  }
  return text;
}

export interface ParameterQuestion {
  id: string;
  nodeName: string;
  parameterName: string;
  type: "string" | "number" | "boolean" | "password";
  label: string;
  question: string;
  description?: string;
  placeholder?: string;
}

export function extractQuestions(input: unknown): ParameterQuestion[] {
  const text = stringify(input).trim();
  if (!text) {
    return [];
  }
  
  // 1. Try to match the fenced block (for compatibility)
  const match = text.match(/```json-questions\s*([\s\S]*?)```/i);
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        return parsed as ParameterQuestion[];
      }
    } catch (e) {
      console.error("Failed to parse json-questions block", e);
    }
  }

  // 2. Try to find the QuestionsList JSON object
  for (const candidate of findJsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.questions)) {
        const questions = parsed.questions;
        // Check if this is the parameter questions (it has missing_parameter_name)
        if (questions.length > 0 && typeof questions[0].missing_parameter_name === "string") {
          return questions.map((q: any) => {
            const param = q.missing_parameter_name || "parameter";
            return {
              id: param,
              nodeName: q.nodeName || "", // Empty if not provided, App.tsx will fallback search
              parameterName: param,
              type: q.type || "string",
              label: q.label || param,
              question: q.question || "",
              description: q.description || "",
              placeholder: q.placeholder || "",
            };
          });
        }
      }
    } catch {
      // ignore
    }
  }

  return [];
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  clarification_key: string;
}

export function extractClarifications(input: unknown): ClarificationQuestion[] {
  const text = stringify(input).trim();
  if (!text) {
    return [];
  }

  // Find the ClarificationQuestionsList JSON object
  for (const candidate of findJsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.questions)) {
        const questions = parsed.questions;
        if (questions.length > 0 && typeof questions[0].clarification_key === "string") {
          return questions as ClarificationQuestion[];
        }
      }
    } catch {
      // ignore
    }
  }

  return [];
}


