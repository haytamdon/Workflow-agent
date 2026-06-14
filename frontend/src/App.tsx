import {
  Activity,
  Bot,
  Braces,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  FileJson,
  HelpCircle,
  Loader2,
  Play,
  RefreshCw,
  Send,
  Settings2,
  Sliders,
  Square,
  Wand2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeBaseUrl,
  runWorkflow,
  type WorkflowRunEvent,
} from "./lib/agentos";
import {
  createWorkflowInN8n,
  getCreateWorkflowState,
  getN8nStatus,
  type CreatedN8nWorkflow,
  type N8nStatus,
} from "./lib/n8n";
import {
  extractAuditMarkdown,
  extractWorkflowJson,
  extractQuestions,
  type N8nWorkflow,
  type WorkflowExtraction,
  type ParameterQuestion,
} from "./lib/results";
import { readStoredValue, writeStoredValue } from "./lib/storage";

const DEFAULT_AGENTOS_BASE_URL =
  import.meta.env.VITE_AGENTOS_BASE_URL || "http://localhost:8000";
const DEFAULT_N8N_BASE_URL =
  import.meta.env.VITE_N8N_BASE_URL || "http://localhost:5678";

const STAGES = [
  { label: "Query Enhancer", token: "query enhancer" },
  { label: "Workflow Designer", token: "workflow designer" },
  { label: "Workflow Creator", token: "workflow creator" },
  { label: "Workflow Validator", token: "workflow validator" },
  { label: "Parameter Detector", token: "parameter detector" },
];

const EXAMPLES = [
  {
    title: "Webhook to Slack",
    prompt:
      "Create an n8n workflow that receives a Stripe payment webhook, verifies the event type, stores the payment summary in Postgres, and notifies a Slack channel.",
    details:
      "Use a webhook trigger, validation logic, Postgres insert, Slack notification, and error handling for missing customer data.",
  },
  {
    title: "Daily Report",
    prompt:
      "Build a scheduled workflow that fetches yesterday's website analytics, summarizes the top changes, and emails a concise report to the operations team.",
    details:
      "Use a daily schedule, HTTP API fetch, Code node transformation, email delivery, retries, and a clear audit trail.",
  },
  {
    title: "CRM Sync",
    prompt:
      "Generate a workflow that syncs new HubSpot contacts into Google Sheets and enriches each record with a company lookup API before writing the row.",
    details:
      "Handle API pagination, duplicate contacts, rate limits, and credential placeholders instead of hardcoded secrets.",
  },
  {
    title: "AI Triage",
    prompt:
      "Design an AI-assisted workflow that classifies incoming support tickets, routes urgent tickets to Slack, and creates follow-up tasks in Notion.",
    details:
      "Use an AI Agent pattern, confidence thresholds, IF routing, Slack escalation, Notion task creation, and safe fallback behavior.",
  },
];

type RunState = "idle" | "running" | "success" | "error";
type ResultTab = "json" | "questions" | "audit" | "raw";

function createSessionId(): string {
  return `workflow-ui-${Date.now().toString(36)}`;
}

function buildGenerationMessage(input: {
  prompt: string;
  integrations: string;
  requirements: string;
}): string {
  const sections = [
    `Workflow request:\n${input.prompt.trim()}`,
    input.integrations.trim()
      ? `Integrations and available credentials:\n${input.integrations.trim()}`
      : "",
    input.requirements.trim()
      ? `Operational requirements:\n${input.requirements.trim()}`
      : "",
    "Return the importable n8n workflow JSON and the validation audit report.",
  ];

  return sections.filter(Boolean).join("\n\n");
}

function getStageIndexFromText(text: string, fallback: number): number {
  const lower = text.toLowerCase();
  const matchedIndex = STAGES.findIndex((stage) => lower.includes(stage.token));
  if (matchedIndex >= 0) {
    return matchedIndex;
  }
  if (lower.includes("enhanced prompt")) {
    return Math.max(fallback, 1);
  }
  if (lower.includes("nodes") && lower.includes("connections")) {
    return Math.max(fallback, 2);
  }
  if (lower.includes("validation") || lower.includes("audit")) {
    return Math.max(fallback, 3);
  }
  if (lower.includes("parameter") || lower.includes("question")) {
    return Math.max(fallback, 4);
  }
  return fallback;
}

function formatRawEvents(events: WorkflowRunEvent[]): string {
  return events
    .map((event) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : JSON.stringify(event.data, null, 2);
      return `[${event.type}]\n${data}`;
    })
    .join("\n\n");
}

function getWorkflowNodeCount(workflow: N8nWorkflow | null): number {
  return workflow?.nodes.length ?? 0;
}

export default function App() {
  const [agentosBaseUrl, setAgentosBaseUrl] = useState(() =>
    normalizeBaseUrl(readStoredValue("workflow-agent.agentos", DEFAULT_AGENTOS_BASE_URL)),
  );
  const [n8nBaseUrl, setN8nBaseUrl] = useState(() =>
    normalizeBaseUrl(readStoredValue("workflow-agent.n8n", DEFAULT_N8N_BASE_URL)),
  );
  const [token, setToken] = useState(() => readStoredValue("workflow-agent.token"));
  const [userId, setUserId] = useState(() =>
    readStoredValue("workflow-agent.user", "workflow-ui-user"),
  );
  const [sessionId, setSessionId] = useState(createSessionId);
  const [prompt, setPrompt] = useState(EXAMPLES[0].prompt);
  const [integrations, setIntegrations] = useState(EXAMPLES[0].details);
  const [requirements, setRequirements] = useState(
    "Use n8n credential references for secrets, include error handling, and keep the workflow importable without manual JSON edits.",
  );
  const [workflowName, setWorkflowName] = useState("Generated workflow");
  const [activateWorkflow, setActivateWorkflow] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
  const [activeStage, setActiveStage] = useState(0);
  const [events, setEvents] = useState<WorkflowRunEvent[]>([]);
  const [rawOutput, setRawOutput] = useState("");
  const [auditMarkdown, setAuditMarkdown] = useState("");
  const [extraction, setExtraction] = useState<WorkflowExtraction>(() =>
    extractWorkflowJson(""),
  );
  const [activeTab, setActiveTab] = useState<ResultTab>("json");
  const [errorMessage, setErrorMessage] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [n8nStatus, setN8nStatus] = useState<N8nStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [createdWorkflow, setCreatedWorkflow] =
    useState<CreatedN8nWorkflow | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  const workflow = extraction.workflow;
  const questions = useMemo(() => {
    return extractQuestions(rawOutput);
  }, [rawOutput]);

  const modifiedWorkflow = useMemo(() => {
    if (!workflow) return null;
    const cloned = JSON.parse(JSON.stringify(workflow));
    questions.forEach((q) => {
      const answerVal = answers[q.id];
      if (answerVal !== undefined && answerVal.trim() !== "") {
        const node = cloned.nodes.find((n: any) => n.name === q.nodeName);
        if (node) {
          if (!node.parameters) {
            node.parameters = {};
          }
          node.parameters[q.parameterName] = answerVal;
        }
      }
    });
    return cloned;
  }, [workflow, questions, answers]);

  const displayJson = useMemo(() => {
    if (!modifiedWorkflow) return "";
    return JSON.stringify(modifiedWorkflow, null, 2);
  }, [modifiedWorkflow]);

  const createState = useMemo(
    () => getCreateWorkflowState(n8nStatus, modifiedWorkflow, isCreating),
    [isCreating, n8nStatus, modifiedWorkflow],
  );

  useEffect(() => {
    writeStoredValue("workflow-agent.agentos", agentosBaseUrl);
  }, [agentosBaseUrl]);

  useEffect(() => {
    writeStoredValue("workflow-agent.n8n", n8nBaseUrl);
  }, [n8nBaseUrl]);

  useEffect(() => {
    writeStoredValue("workflow-agent.token", token);
  }, [token]);

  useEffect(() => {
    writeStoredValue("workflow-agent.user", userId);
  }, [userId]);

  useEffect(() => {
    let isMounted = true;
    setStatusError("");

    getN8nStatus(agentosBaseUrl, token)
      .then((status) => {
        if (isMounted) {
          setN8nStatus(status);
          if (status.editor_url) {
            setN8nBaseUrl(status.editor_url);
          }
        }
      })
      .catch((error: Error) => {
        if (isMounted) {
          setN8nStatus(null);
          setStatusError(error.message);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [agentosBaseUrl, token]);

  async function handleGenerate() {
    if (!prompt.trim() || runState === "running") {
      return;
    }

    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    const eventBuffer: WorkflowRunEvent[] = [];

    setRunState("running");
    setActiveStage(0);
    setEvents([]);
    setRawOutput("");
    setAuditMarkdown("");
    setExtraction(extractWorkflowJson(""));
    setAnswers({});
    setErrorMessage("");
    setCreatedWorkflow(null);
    setCopyState("idle");

    try {
      const response = await runWorkflow({
        agentosBaseUrl,
        token,
        userId,
        sessionId,
        stream: true,
        signal: abortController.signal,
        message: buildGenerationMessage({ prompt, integrations, requirements }),
        onEvent: (event) => {
          eventBuffer.push(event);
          setEvents([...eventBuffer]);
          const formatted = formatRawEvents(eventBuffer);
          setRawOutput(formatted);
          setActiveStage((current) => getStageIndexFromText(event.text, current));
        },
      });

      const finalRaw =
        response.rawText ||
        rawOutput ||
        formatRawEvents(response.events.length ? response.events : eventBuffer);
      const finalExtraction = extractWorkflowJson(
        finalRaw || response.payload || response.events,
      );

      setRawOutput(finalRaw);
      setAuditMarkdown(extractAuditMarkdown(finalRaw || response.payload));
      setExtraction(finalExtraction);
      setActiveStage(STAGES.length - 1);
      setRunState("success");
      setActiveTab(finalExtraction.workflow ? "json" : "raw");
    } catch (error) {
      if (abortController.signal.aborted) {
        setErrorMessage("Generation stopped.");
      } else {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
      setRunState("error");
    } finally {
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  async function handleCopyJson() {
    if (!displayJson) {
      return;
    }
    try {
      await navigator.clipboard.writeText(displayJson);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  function handleDownloadJson() {
    if (!displayJson) {
      return;
    }
    const blob = new Blob([displayJson], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${workflowName.trim() || "n8n-workflow"}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleCreateInN8n() {
    if (!modifiedWorkflow || createState.disabled) {
      return;
    }

    setIsCreating(true);
    setErrorMessage("");
    try {
      const created = await createWorkflowInN8n({
        agentosBaseUrl,
        token,
        name: workflowName.trim() || "Generated workflow",
        workflow: modifiedWorkflow,
        activate: activateWorkflow,
      });
      setCreatedWorkflow(created);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCreating(false);
    }
  }

  function applyExample(example: (typeof EXAMPLES)[number]) {
    setPrompt(example.prompt);
    setIntegrations(example.details);
    setWorkflowName(example.title);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <Bot size={24} />
        </div>
        <div className="brand-copy">
          <h1>Workflow Agent</h1>
          <span>AgentOS to n8n</span>
        </div>
        <div className="topbar-actions">
          <a
            className="ghost-button"
            href={n8nBaseUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={16} />
            n8n
          </a>
          <button
            className="icon-button"
            type="button"
            title="Settings"
            onClick={() => setShowSettings((value) => !value)}
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      {showSettings ? (
        <section className="settings-band" aria-label="Settings">
          <label>
            <span>AgentOS URL</span>
            <input
              value={agentosBaseUrl}
              onChange={(event) => setAgentosBaseUrl(event.target.value)}
            />
          </label>
          <label>
            <span>n8n URL</span>
            <input
              value={n8nBaseUrl}
              onChange={(event) => setN8nBaseUrl(event.target.value)}
            />
          </label>
          <label>
            <span>User ID</span>
            <input value={userId} onChange={(event) => setUserId(event.target.value)} />
          </label>
          <label>
            <span>Bearer token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
            />
          </label>
        </section>
      ) : null}

      <section className="workspace">
        <section className="composer-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Request</p>
              <h2>Generate workflow</h2>
            </div>
            <Wand2 size={22} />
          </div>

          <div className="example-grid">
            {EXAMPLES.map((example) => (
              <button
                key={example.title}
                className="example-card"
                type="button"
                onClick={() => applyExample(example)}
              >
                <span>{example.title}</span>
              </button>
            ))}
          </div>

          <label className="field-block">
            <span>Natural language request</span>
            <textarea
              className="prompt-area"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          <label className="field-block">
            <span>Integrations</span>
            <textarea
              value={integrations}
              onChange={(event) => setIntegrations(event.target.value)}
            />
          </label>

          <label className="field-block">
            <span>Requirements</span>
            <textarea
              value={requirements}
              onChange={(event) => setRequirements(event.target.value)}
            />
          </label>

          <div className="inline-fields">
            <label>
              <span>Workflow name</span>
              <input
                value={workflowName}
                onChange={(event) => setWorkflowName(event.target.value)}
              />
            </label>
            <label>
              <span>Session</span>
              <div className="input-action">
                <input
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                />
                <button
                  className="icon-button compact"
                  type="button"
                  title="New session"
                  onClick={() => setSessionId(createSessionId())}
                >
                  <RefreshCw size={16} />
                </button>
              </div>
            </label>
          </div>

          <div className="composer-actions">
            {runState === "running" ? (
              <button className="danger-button" type="button" onClick={handleStop}>
                <Square size={16} />
                Stop
              </button>
            ) : (
              <button className="primary-button" type="button" onClick={handleGenerate}>
                <Send size={17} />
                Generate
              </button>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={activateWorkflow}
                onChange={(event) => setActivateWorkflow(event.target.checked)}
              />
              <span>Activate after create</span>
            </label>
          </div>
        </section>

        <section className="status-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Run</p>
              <h2>Pipeline</h2>
            </div>
            {runState === "running" ? (
              <Loader2 className="spin" size={22} />
            ) : (
              <Activity size={22} />
            )}
          </div>

          <div className="stage-list">
            {STAGES.map((stage, index) => {
              const isComplete = runState === "success" || index < activeStage;
              const isActive = runState === "running" && index === activeStage;
              return (
                <div
                  className={[
                    "stage-row",
                    isComplete ? "complete" : "",
                    isActive ? "active" : "",
                  ].join(" ")}
                  key={stage.label}
                >
                  <span className="stage-dot">
                    {isComplete ? <CheckCircle2 size={15} /> : index + 1}
                  </span>
                  <span>{stage.label}</span>
                </div>
              );
            })}
          </div>

          <div className="metric-grid">
            <div>
              <span>Events</span>
              <strong>{events.length}</strong>
            </div>
            <div>
              <span>Nodes</span>
              <strong>{getWorkflowNodeCount(workflow)}</strong>
            </div>
            <div>
              <span>n8n API</span>
              <strong>{n8nStatus?.configured ? "Ready" : "Manual"}</strong>
            </div>
          </div>

          {statusError ? <p className="notice warning">{statusError}</p> : null}
          {errorMessage ? (
            <p className="notice error">
              <XCircle size={16} />
              {errorMessage}
            </p>
          ) : null}
          {createdWorkflow ? (
            <a
              className="notice success"
              href={createdWorkflow.url}
              target="_blank"
              rel="noreferrer"
            >
              <CheckCircle2 size={16} />
              Created in n8n
            </a>
          ) : null}
        </section>

        <section className="results-panel">
          <div className="results-header">
            <div className="tabs" role="tablist" aria-label="Results">
              <button
                className={activeTab === "json" ? "active" : ""}
                type="button"
                onClick={() => setActiveTab("json")}
              >
                <FileJson size={16} />
                JSON
              </button>
              <button
                className={activeTab === "questions" ? "active" : ""}
                type="button"
                onClick={() => setActiveTab("questions")}
              >
                <HelpCircle size={16} />
                Questions
              </button>
              <button
                className={activeTab === "audit" ? "active" : ""}
                type="button"
                onClick={() => setActiveTab("audit")}
              >
                <Braces size={16} />
                Audit
              </button>
              <button
                className={activeTab === "raw" ? "active" : ""}
                type="button"
                onClick={() => setActiveTab("raw")}
              >
                <Play size={16} />
                Raw
              </button>
            </div>
            <div className="result-actions">
              <button
                className="icon-button"
                type="button"
                title="Copy JSON"
                disabled={!displayJson}
                onClick={handleCopyJson}
              >
                {copyState === "copied" ? <CheckCircle2 size={17} /> : <Clipboard size={17} />}
              </button>
              <button
                className="icon-button"
                type="button"
                title="Download JSON"
                disabled={!displayJson}
                onClick={handleDownloadJson}
              >
                <Download size={17} />
              </button>
              <button
                className="secondary-button"
                type="button"
                title={createState.reason}
                disabled={createState.disabled}
                onClick={handleCreateInN8n}
              >
                {isCreating ? <Loader2 className="spin" size={16} /> : <ExternalLink size={16} />}
                Create
              </button>
            </div>
          </div>

          <div className="result-body">
            {activeTab === "json" ? (
              displayJson ? (
                <pre>{displayJson}</pre>
              ) : (
                <div className="empty-state">
                  <FileJson size={28} />
                  <span>{extraction.error}</span>
                </div>
              )
            ) : null}
            {activeTab === "questions" ? (
              questions.length > 0 ? (
                <div className="setup-questions-form">
                  <div className="setup-intro">
                    <p className="setup-description">
                      The agent has detected that the generated workflow requires custom configurations.
                      Provide your values below to dynamically configure your workflow.
                    </p>
                  </div>
                  <div className="setup-grid">
                    {questions.map((q) => (
                      <div className="setup-field-card" key={q.id}>
                        <div className="field-meta">
                          <span className="node-badge">{q.nodeName}</span>
                          <span className="param-badge">{q.parameterName}</span>
                        </div>
                        <label className="setup-label">
                          <span className="question-text">{q.question}</span>
                          {q.description && (
                            <span className="field-desc">{q.description}</span>
                          )}
                          <input
                            type={q.type === "password" ? "password" : "text"}
                            className="setup-input"
                            value={answers[q.id] || ""}
                            placeholder={q.placeholder || `Enter ${q.label}`}
                            onChange={(e) => {
                              setAnswers((prev) => ({
                                ...prev,
                                [q.id]: e.target.value,
                              }));
                            }}
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <Sliders size={28} />
                  <span>
                    {runState === "success"
                      ? "No required parameters or credentials were found for this workflow."
                      : "Questions will appear here once parameter detection runs."}
                  </span>
                </div>
              )
            ) : null}
            {activeTab === "audit" ? (
              auditMarkdown ? (
                <pre>{auditMarkdown}</pre>
              ) : (
                <div className="empty-state">
                  <Braces size={28} />
                  <span>Audit output will appear here.</span>
                </div>
              )
            ) : null}
            {activeTab === "raw" ? (
              rawOutput ? (
                <pre>{rawOutput}</pre>
              ) : (
                <div className="empty-state">
                  <Activity size={28} />
                  <span>Run events will appear here.</span>
                </div>
              )
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
