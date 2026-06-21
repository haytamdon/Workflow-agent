import {
  Activity,
  Bot,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Download,
  ExternalLink,
  FileJson,
  HelpCircle,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  Send,
  Settings2,
  Sliders,
  Square,
  Sun,
  Wand2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeBaseUrl,
  runWorkflow,
  getWorkflowLogs,
  type WorkflowRunEvent,
} from "./lib/workflow_api";

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
  extractClarifications,
  type N8nWorkflow,
  type WorkflowExtraction,
  type ParameterQuestion,
  type ClarificationQuestion,
} from "./lib/results";
import { readStoredValue, writeStoredValue } from "./lib/storage";

const DEFAULT_AGENTOS_BASE_URL =
  import.meta.env.VITE_AGENTOS_BASE_URL ||
  (import.meta.env.DEV ? "http://localhost:8000" : window.location.origin);
const DEFAULT_N8N_BASE_URL =
  import.meta.env.VITE_N8N_BASE_URL ||
  (import.meta.env.DEV ? "http://localhost:5678" : `${window.location.protocol}//${window.location.hostname}:5678`);

const STAGES = [
  { label: "Needs Clarifier", token: "needs clarifier" },
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
type ResultTab = "json" | "audit" | "raw";

function renderMessageText(text: string, handleDownloadJson?: () => void, displayJson?: string) {
  if (!text) return null;
  if (text.startsWith("[RUNNING_STAGE]")) {
    const stage = text.replace("[RUNNING_STAGE]", "").trim();
    return (
      <div className="stage-loader">
        <Loader2 className="stage-loader-spinner spin" size={16} style={{ animation: "spin 1s linear infinite" }} />
        <span className="stage-loader-text">Running: {stage}...</span>
      </div>
    );
  }
  if (text.startsWith("[DOWNLOAD_WORKFLOW]")) {
    const name = text.replace("[DOWNLOAD_WORKFLOW]", "").trim() || "Generated n8n Workflow";
    return (
      <div className="download-card">
        <div className="download-card-icon-container">
          <FileJson size={22} />
        </div>
        <div className="download-card-details">
          <div className="download-card-title">{name}</div>
          <div className="download-card-subtitle">n8n Workflow · JSON</div>
        </div>
        <div className="download-card-actions">
          <button 
            type="button" 
            className="download-card-button"
            onClick={handleDownloadJson}
            disabled={!displayJson}
          >
            <Download size={14} />
            Download
          </button>
        </div>
      </div>
    );
  }
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, index) => {
    if (part.startsWith("```")) {
      const match = part.match(/```(\w+)?\n([\s\S]*?)```/);
      const lang = match ? match[1] : "";
      const code = match ? match[2] : part.slice(3, -3);
      return (
        <pre key={index} style={{ margin: "0.5rem 0", padding: "0.75rem", background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-color)", borderRadius: "6px", overflowX: "auto" }}>
          {lang && <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "0.25rem" }}>{lang}</div>}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>{code.trim()}</code>
        </pre>
      );
    }

    const lines = part.split("\n").map((line, lineIdx) => {
      const boldSegments = line.split(/(\*\*.*?\*\*)/);
      return (
        <p key={lineIdx} style={{ minHeight: line === "" ? "1em" : "auto" }}>
          {boldSegments.map((seg, segIdx) => {
            if (seg.startsWith("**") && seg.endsWith("**")) {
              return <strong key={segIdx}>{seg.slice(2, -2)}</strong>;
            }
            const inlineCodeSegments = seg.split(/(`[^`]+`)/);
            return inlineCodeSegments.map((inlineSeg, inlineIdx) => {
              if (inlineSeg.startsWith("`") && inlineSeg.endsWith("`")) {
                return (
                  <code key={inlineIdx} style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em", background: "rgba(255,255,255,0.05)", padding: "0.1em 0.3em", borderRadius: "3px" }}>
                    {inlineSeg.slice(1, -1)}
                  </code>
                );
              }
              return inlineSeg;
            });
          })}
        </p>
      );
    });
    return <span key={index}>{lines}</span>;
  });
}


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
  if (lower.includes("clarification")) {
    return Math.max(fallback, 1);
  }
  if (lower.includes("enhanced prompt")) {
    return Math.max(fallback, 2);
  }
  if (lower.includes("nodes") && lower.includes("connections")) {
    return Math.max(fallback, 4);
  }
  if (lower.includes("validation") || lower.includes("audit")) {
    return Math.max(fallback, 5);
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

interface ChatMessage {
  id: string;
  sender: "user" | "bot" | "system";
  text: string;
  timestamp: Date;
}

function getWorkflowNodeCount(workflow: N8nWorkflow | null): number {
  return workflow?.nodes.length ?? 0;
}

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (readStoredValue("workflow-agent.theme") as "dark" | "light") || "dark";
  });
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
  const [dbLogs, setDbLogs] = useState<any[]>([]);
  const [activeQuestionType, setActiveQuestionType] = useState<"clarifications" | "parameters" | null>(null);
  const [formAnswers, setFormAnswers] = useState<Record<string, string>>({});
  const [currentClarificationIndex, setCurrentClarificationIndex] = useState(0);
  const [currentParameterIndex, setCurrentParameterIndex] = useState(0);

  useEffect(() => {
    setCurrentClarificationIndex(0);
    setCurrentParameterIndex(0);
  }, [activeQuestionType]);

  const activeBotMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (runState === "running" && activeBotMsgIdRef.current) {
      const stageLabel = STAGES[activeStage]?.label || "Processing";
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === activeBotMsgIdRef.current
            ? { ...msg, text: `[RUNNING_STAGE] ${stageLabel}` }
            : msg
        )
      );
    }
  }, [activeStage, runState]);


  
  // Chatbot state
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: "welcome",
      sender: "bot",
      text: "Hi! I am your AI Workflow Agent. I can help you design, validate, and create n8n workflows.\n\nDescribe the workflow you want to build in the box below to get started!",
      timestamp: new Date(),
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Theme effect
  useEffect(() => {
    writeStoredValue("workflow-agent.theme", theme);
    document.documentElement.className = `theme-${theme}`;
  }, [theme]);

  // Autoscroll effect
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, runState]);

  const workflow = extraction.workflow;
  const questions = useMemo(() => {
    return extractQuestions(rawOutput);
  }, [rawOutput]);

  const clarifications = useMemo(() => {
    return extractClarifications(rawOutput);
  }, [rawOutput]);

  const modifiedWorkflow = useMemo(() => {
    if (!workflow) return null;
    const cloned = JSON.parse(JSON.stringify(workflow));
    questions.forEach((q) => {
      const answerVal = answers[q.id];
      if (answerVal !== undefined && answerVal.trim() !== "") {
        let node = q.nodeName ? cloned.nodes.find((n: any) => n.name === q.nodeName) : null;
        if (!node && q.parameterName) {
          node = cloned.nodes.find(
            (n: any) => n.parameters && q.parameterName in n.parameters,
          );
        }
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

  // Poll database agent execution logs while running
  useEffect(() => {
    if (runState !== "running") {
      return;
    }
    const fetchLogs = async () => {
      try {
        const logs = await getWorkflowLogs(agentosBaseUrl, sessionId, token);
        setDbLogs(logs);
      } catch (err) {
        console.error("Error fetching agent logs:", err);
      }
    };
    fetchLogs(); // initial call
    const interval = setInterval(fetchLogs, 1500);
    return () => clearInterval(interval);
  }, [runState, agentosBaseUrl, sessionId, token]);

  // Sync active stepper stage with the latest logged agent from the DB
  useEffect(() => {
    if (dbLogs.length > 0) {
      const latestLog = dbLogs[dbLogs.length - 1];
      const matchedIndex = STAGES.findIndex(
        (stage) => latestLog.agent_name.toLowerCase().replace(/_/g, " ") === stage.token
      );
      if (matchedIndex >= 0) {
        setActiveStage(matchedIndex);
      }
    }
  }, [dbLogs]);


  async function runGenerationFlow(
    currentPrompt: string,
    botMsgId: string,
    overrideIntegrations?: string,
    overrideAnswers?: Record<string, string>
  ) {
    activeBotMsgIdRef.current = botMsgId;
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
    setErrorMessage("");
    setCreatedWorkflow(null);
    setCopyState("idle");
    setDbLogs([]); // Reset log cache

    const integrationsToUse = overrideIntegrations !== undefined ? overrideIntegrations : integrations;
    const answersToUse = overrideAnswers !== undefined ? overrideAnswers : answers;

    const answeredClarifications = clarifications
      .map((q) => {
        const answer = answersToUse[q.id];
        return answer?.trim() ? `- ${q.question} Answer: ${answer.trim()}` : null;
      })
      .filter(Boolean)
      .join("\n");

    const baseMessage = buildGenerationMessage({
      prompt: currentPrompt,
      integrations: integrationsToUse,
      requirements,
    });
    const finalMessage = answeredClarifications
      ? `${baseMessage}\n\nUser's clarifications to previous questions:\n${answeredClarifications}`
      : baseMessage;

    let accumulatedText = "";

    try {
      const response = await runWorkflow({
        agentosBaseUrl,
        token,
        userId,
        sessionId,
        stream: true,
        signal: abortController.signal,
        message: finalMessage,
        answers: answersToUse, // Send answers payload to FastAPI Form field
        onEvent: (event) => {

          eventBuffer.push(event);
          setEvents([...eventBuffer]);
          const formatted = formatRawEvents(eventBuffer);
          setRawOutput(formatted);
          
          if (event.text) {
            accumulatedText += event.text;
          }
          setActiveStage((current) => getStageIndexFromText(event.text, current));
        },
      });

      const finalRaw =
        response.rawText ||
        accumulatedText ||
        formatRawEvents(response.events.length ? response.events : eventBuffer);
      const finalExtraction = extractWorkflowJson(
          finalRaw || response.payload || response.events
      );

      setRawOutput(finalRaw);
      setAuditMarkdown(extractAuditMarkdown(finalRaw || response.payload));
      setExtraction(finalExtraction);
      setActiveStage(STAGES.length - 1);
      setRunState("success");

      const finalClarifications = extractClarifications(finalRaw);
      const finalQuestions = extractQuestions(finalRaw);

      if (finalClarifications.length > 0) {
        setActiveTab("json");
        setActiveQuestionType("clarifications");
        const initialFormAnswers: Record<string, string> = {};
        finalClarifications.forEach((q) => {
          initialFormAnswers[q.id] = answers[q.id] || "";
        });
        setFormAnswers(initialFormAnswers);
        
        setMessages((prev) => {
          const next = prev.map((msg) =>
            msg.id === botMsgId
              ? {
                  ...msg,
                  text: "I need a few clarifications to proceed with designing your workflow. Please answer the questions below.",
                }
              : msg
          );
          return [
            ...next,
            {
              id: `sys-clarify-${Date.now()}`,
              sender: "system",
              text: "Clarification questions require response in the bottom input box.",
              timestamp: new Date(),
            },
          ];
        });
      } else if (finalQuestions.length > 0) {
        setActiveTab("json");
        setActiveQuestionType("parameters");
        const initialFormAnswers: Record<string, string> = {};
        finalQuestions.forEach((q) => {
          initialFormAnswers[q.id] = answers[q.id] || "";
        });
        setFormAnswers(initialFormAnswers);

        setMessages((prev) => {
          const next = prev.map((msg) =>
            msg.id === botMsgId
              ? {
                  ...msg,
                  text: "I have detected some parameters in the workflow that need configuration. Please configure them below.",
                }
              : msg
          );
          return [
            ...next,
            {
              id: `sys-params-${Date.now()}`,
              sender: "system",
              text: "Workflow configuration parameters require values in the bottom input box.",
              timestamp: new Date(),
            },
          ];
        });
      } else {
        if (finalExtraction.workflow) {
          setActiveTab("json");
        } else {
          setActiveTab("raw");
        }
        setMessages((prev) => {
          const next = prev.map((msg) =>
            msg.id === botMsgId
              ? { ...msg, text: `[DOWNLOAD_WORKFLOW] ${workflowName || "Generated workflow"}` }
              : msg
          );
          return [
            ...next,
            {
              id: `sys-success-${Date.now()}`,
              sender: "system",
              text: "Workflow generated successfully! Review, copy, and create it in n8n on the right panel.",
              timestamp: new Date(),
            },
          ];
        });
      }
    } catch (error) {
      let errorText = "";
      if (abortController.signal.aborted) {
        errorText = "Generation stopped.";
        setErrorMessage("Generation stopped.");
      } else {
        errorText = error instanceof Error ? error.message : String(error);
        setErrorMessage(errorText);
      }
      setRunState("error");
      
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === botMsgId
            ? { ...msg, text: `Generation failed. Error: ${errorText}` }
            : msg
        )
      );
    } finally {
      abortRef.current = null;
    }
  }

  async function handleSendChatMessage(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!chatInput.trim() || runState === "running") {
      return;
    }

    const userPrompt = chatInput.trim();
    setPrompt(userPrompt);
    setChatInput("");

    const userMsgId = `user-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      sender: "user",
      text: userPrompt,
      timestamp: new Date(),
    };

    const botMsgId = `bot-${Date.now()}`;
    const botMsg: ChatMessage = {
      id: botMsgId,
      sender: "bot",
      text: "Thinking...",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg, botMsg]);
    await runGenerationFlow(userPrompt, botMsgId);
  }

  function handleClarificationSubmit(e: React.FormEvent) {
    e.preventDefault();
    
    const updatedAnswers = { ...answers, ...formAnswers };
    setAnswers(updatedAnswers);
    setActiveQuestionType(null);

    const answersText = Object.entries(formAnswers)
      .map(([key, val]) => {
        const q = clarifications.find((c) => c.id === key);
        return `- **${q?.question || key}**: ${val}`;
      })
      .join("\n");

    const userMsgId = `user-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      sender: "user",
      text: `Here are my clarifications:\n\n${answersText}`,
      timestamp: new Date(),
    };

    const botMsgId = `bot-${Date.now()}`;
    const botMsg: ChatMessage = {
      id: botMsgId,
      sender: "bot",
      text: "Thinking...",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg, botMsg]);
    runGenerationFlow(prompt, botMsgId, undefined, updatedAnswers);
  }

  async function handleParametersApply(e: React.FormEvent) {
    e.preventDefault();
    
    const updatedAnswers = { ...answers, ...formAnswers };
    setAnswers(updatedAnswers);
    setActiveQuestionType(null);

    const answersText = Object.entries(formAnswers)
      .map(([key, val]) => {
        const q = questions.find((c) => c.id === key);
        return `- **${q?.question || key}**: ${val}`;
      })
      .join("\n");

    const userMsgId = `user-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      sender: "user",
      text: `Applying configuration parameters:\n\n${answersText}`,
      timestamp: new Date(),
    };

    const botMsgId = `bot-${Date.now()}`;
    const botMsg: ChatMessage = {
      id: botMsgId,
      sender: "bot",
      text: "Injecting parameters into workflow...",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg, botMsg]);
    await runGenerationFlow(prompt, botMsgId, undefined, updatedAnswers);
  }


  function handleResetSession() {
    abortRef.current?.abort();
    setSessionId(createSessionId());
    setPrompt("");
    setAnswers({});
    setFormAnswers({});
    setActiveQuestionType(null);
    setRawOutput("");
    setAuditMarkdown("");
    setExtraction(extractWorkflowJson(""));
    setErrorMessage("");
    setCreatedWorkflow(null);
    setRunState("idle");
    setActiveStage(0);
    setDbLogs([]);
    setMessages([
      {
        id: "welcome",
        sender: "bot",
        text: "Hi! I am your AI Workflow Agent. I can help you design, validate, and create n8n workflows.\n\nDescribe the workflow you want to build in the box below to get started!",
        timestamp: new Date(),
      },
    ]);
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function applyExample(example: (typeof EXAMPLES)[number]) {
    setPrompt(example.prompt);
    setIntegrations(example.details);
    setWorkflowName(example.title);
    setAnswers({});
    setFormAnswers({});
    setActiveQuestionType(null);

    const userMsgId = `user-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      sender: "user",
      text: `Create workflow: ${example.title}\n\nPrompt: ${example.prompt}`,
      timestamp: new Date(),
    };

    const botMsgId = `bot-${Date.now()}`;
    const botMsg: ChatMessage = {
      id: botMsgId,
      sender: "bot",
      text: "Thinking...",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg, botMsg]);
    runGenerationFlow(example.prompt, botMsgId, example.details);
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <Bot size={24} />
        </div>
        <div className="brand-copy">
          <h1>Workflow Agent</h1>
          <span>Workflow API to n8n</span>
        </div>

        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
            onClick={() => setTheme((curr) => (curr === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
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
            <span>Workflow API URL</span>
            <input
              type="text"
              value={agentosBaseUrl}
              onChange={(event) => setAgentosBaseUrl(event.target.value)}
            />
          </label>

          <label>
            <span>n8n URL</span>
            <input
              type="text"
              value={n8nBaseUrl}
              onChange={(event) => setN8nBaseUrl(event.target.value)}
            />
          </label>
          <label>
            <span>User ID</span>
            <input type="text" value={userId} onChange={(event) => setUserId(event.target.value)} />
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
        <section className="chat-panel">
          <div className="chat-messages">
            {messages.map((msg) => (
              <div key={msg.id} className={`chat-message ${msg.sender}`}>
                {msg.sender !== "system" && (
                  <div className="message-avatar">
                    {msg.sender === "user" ? <Bot size={16} style={{ transform: "rotate(180deg)" }} /> : <Bot size={16} />}
                  </div>
                )}
                <div className="message-bubble">
                  {msg.sender === "system" ? (
                    <span style={{ fontStyle: "italic", fontSize: "0.8rem" }}>{msg.text}</span>
                  ) : (
                    renderMessageText(msg.text, handleDownloadJson, displayJson)

                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="chat-input-container">
            {activeQuestionType === "clarifications" && clarifications.length > 0 && (
              <form onSubmit={handleClarificationSubmit} className="active-question-form">
                <div className="active-question-header">
                  <span className="active-question-title">
                    Clarifications ({currentClarificationIndex + 1} of {clarifications.length})
                  </span>
                  <HelpCircle size={16} style={{ color: "var(--color-primary)" }} />
                </div>
                <div className="active-question-fields">
                  {(() => {
                    const q = clarifications[currentClarificationIndex];
                    if (!q) return null;
                    return (
                      <div className="active-question-field" key={q.id}>
                        <label htmlFor={`clarify-${q.id}`}>{q.question}</label>
                        <input
                          id={`clarify-${q.id}`}
                          type="text"
                          value={formAnswers[q.id] || ""}
                          placeholder="Type clarification here..."
                          autoFocus
                          onChange={(e) => {
                            setFormAnswers((prev) => ({
                              ...prev,
                              [q.id]: e.target.value,
                            }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              if (currentClarificationIndex < clarifications.length - 1) {
                                if (formAnswers[q.id]?.trim()) {
                                  setCurrentClarificationIndex((curr) => curr + 1);
                                }
                              } else {
                                if (formAnswers[q.id]?.trim()) {
                                  handleClarificationSubmit(e);
                                }
                              }
                            }
                          }}
                        />
                      </div>
                    );
                  })()}
                </div>
                <div className="active-question-actions" style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: "0.5rem" }}>
                  <div>
                    {currentClarificationIndex > 0 && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => setCurrentClarificationIndex((curr) => curr - 1)}
                      >
                        Back
                      </button>
                    )}
                  </div>
                  <div>
                    {currentClarificationIndex < clarifications.length - 1 ? (
                      <button
                        className="primary-button"
                        type="button"
                        disabled={!formAnswers[clarifications[currentClarificationIndex]?.id]?.trim()}
                        onClick={() => setCurrentClarificationIndex((curr) => curr + 1)}
                      >
                        Next
                      </button>
                    ) : (
                      <button
                        className="primary-button"
                        type="submit"
                        disabled={!formAnswers[clarifications[currentClarificationIndex]?.id]?.trim()}
                      >
                        <Send size={14} />
                        Submit Answers
                      </button>
                    )}
                  </div>
                </div>
              </form>
            )}

            {activeQuestionType === "parameters" && questions.length > 0 && (
              <form onSubmit={handleParametersApply} className="active-question-form">
                <div className="active-question-header">
                  <span className="active-question-title">
                    Parameters ({currentParameterIndex + 1} of {questions.length})
                  </span>
                  <Sliders size={16} style={{ color: "var(--color-primary)" }} />
                </div>
                <div className="active-question-fields">
                  {(() => {
                    const q = questions[currentParameterIndex];
                    if (!q) return null;
                    return (
                      <div className="active-question-field" key={q.id}>
                        <label htmlFor={`param-${q.id}`}>
                          {q.question} 
                          {q.nodeName && <span className="node-badge" style={{ marginLeft: "0.5rem" }}>{q.nodeName}</span>}
                        </label>
                        {q.description && <span className="field-desc">{q.description}</span>}
                        <input
                          id={`param-${q.id}`}
                          type={q.type === "password" ? "password" : "text"}
                          value={formAnswers[q.id] || ""}
                          placeholder={q.placeholder || `Enter ${q.label}`}
                          autoFocus
                          onChange={(e) => {
                            setFormAnswers((prev) => ({
                              ...prev,
                              [q.id]: e.target.value,
                            }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              if (currentParameterIndex < questions.length - 1) {
                                if (formAnswers[q.id]?.trim()) {
                                  setCurrentParameterIndex((curr) => curr + 1);
                                }
                              } else {
                                if (formAnswers[q.id]?.trim()) {
                                  handleParametersApply(e);
                                }
                              }
                            }
                          }}
                        />
                      </div>
                    );
                  })()}
                </div>
                <div className="active-question-actions" style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: "0.5rem" }}>
                  <div>
                    {currentParameterIndex > 0 && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => setCurrentParameterIndex((curr) => curr - 1)}
                      >
                        Back
                      </button>
                    )}
                  </div>
                  <div>
                    {currentParameterIndex < questions.length - 1 ? (
                      <button
                        className="primary-button"
                        type="button"
                        disabled={!formAnswers[questions[currentParameterIndex]?.id]?.trim()}
                        onClick={() => setCurrentParameterIndex((curr) => curr + 1)}
                      >
                        Next
                      </button>
                    ) : (
                      <button
                        className="primary-button"
                        type="submit"
                        disabled={!formAnswers[questions[currentParameterIndex]?.id]?.trim()}
                      >
                        Apply Parameters
                      </button>
                    )}
                  </div>
                </div>
              </form>
            )}

            {activeQuestionType === null && (
              <>
                <form onSubmit={handleSendChatMessage} className="chat-input-row">
                  <textarea
                    className="chat-input-textarea"
                    value={chatInput}
                    placeholder={runState === "running" ? "Workflow generation is running..." : "Describe the workflow you want to build... (e.g., Create a stripe payment webhook stored in Postgres)"}
                    disabled={runState === "running"}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendChatMessage();
                      }
                    }}
                  />
                  {runState === "running" ? (
                    <button className="danger-button" type="button" onClick={handleStop} style={{ padding: "0.65rem" }}>
                      <Square size={16} />
                    </button>
                  ) : (
                    <button className="primary-button" type="submit" disabled={!chatInput.trim()} style={{ padding: "0.65rem" }}>
                      <Send size={16} />
                    </button>
                  )}
                </form>
                
                <div className="chat-input-actions">
                  <button 
                    type="button" 
                    className="advanced-options-toggle"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                  >
                    {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    Advanced Context
                  </button>
                  
                  <button 
                    type="button" 
                    className="ghost-button" 
                    style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
                    onClick={handleResetSession}
                  >
                    <RefreshCw size={12} />
                    Reset Session
                  </button>
                </div>

                {showAdvanced && (
                  <div className="advanced-options-drawer">
                    <label>
                      <span>Integrations & Credentials Context</span>
                      <textarea
                        value={integrations}
                        placeholder="Define integrations or credentials references here..."
                        onChange={(e) => setIntegrations(e.target.value)}
                      />
                    </label>
                    <label>
                      <span>Operational Requirements</span>
                      <textarea
                        value={requirements}
                        placeholder="Define custom parameters like retries, validation rules..."
                        onChange={(e) => setRequirements(e.target.value)}
                      />
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section className="results-panel">
          <div className="pipeline-stepper">
            <div className="pipeline-progress-line">
              <div 
                className="pipeline-progress-fill" 
                style={{ width: `${(activeStage / (STAGES.length - 1)) * 100}%` }}
              />
            </div>
            {STAGES.map((stage, index) => {
              const isComplete = runState === "success" || index < activeStage;
              const isActive = runState === "running" && index === activeStage;
              return (
                <div 
                  key={stage.label} 
                  className={`pipeline-step ${isComplete ? "complete" : ""} ${isActive ? "active" : ""}`}
                >
                  <div className="pipeline-step-dot">
                    {isComplete ? <CheckCircle2 size={12} /> : index + 1}
                  </div>
                  <span className="pipeline-step-label">{stage.label}</span>
                </div>
              );
            })}
          </div>

          {dbLogs.length > 0 && (
            <div className="db-logs-panel" style={{
              margin: "0 1.5rem 1rem 1.5rem",
              padding: "0.75rem",
              background: "rgba(255, 255, 255, 0.03)",
              border: "1px solid var(--border-color)",
              borderRadius: "8px",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.2)"
            }}>
              <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: "0.4rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Agent Execution Logs (Traces)
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                {dbLogs.map((log, index) => {
                  const isRunning = log.status === "running";
                  const isCompleted = log.status === "completed";
                  const isFailed = log.status === "failed";
                  let statusColor = "var(--text-muted)";
                  if (isRunning) statusColor = "var(--color-primary)";
                  if (isCompleted) statusColor = "#4caf50";
                  if (isFailed) statusColor = "#f44336";
                  
                  return (
                    <div key={index} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.72rem", padding: "0.25rem 0.5rem", background: "rgba(255,255,255,0.02)", borderRadius: "4px" }}>
                      <span style={{ fontWeight: 500, color: "var(--text-color)" }}>{log.agent_name.replace(/_/g, " ").toUpperCase()}</span>
                      <span style={{ color: statusColor, fontWeight: 600, display: "flex", alignItems: "center", gap: "0.25rem" }}>
                        {isRunning && <Loader2 size={10} className="spin" style={{ animation: "spin 1s linear infinite" }} />}
                        {log.status.toUpperCase()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}


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

          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border-color)", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div className="inline-fields" style={{ marginBottom: 0 }}>
              <label>
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>Workflow name</span>
                <input
                  type="text"
                  value={workflowName}
                  onChange={(event) => setWorkflowName(event.target.value)}
                  style={{ padding: "0.4rem 0.65rem", fontSize: "0.8rem" }}
                />
              </label>
              <label className="check-row" style={{ marginTop: "1.2rem" }}>
                <input
                  type="checkbox"
                  checked={activateWorkflow}
                  onChange={(event) => setActivateWorkflow(event.target.checked)}
                />
                <span>Activate in n8n</span>
              </label>
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
          </div>
        </section>
      </section>
    </main>
  );
}
