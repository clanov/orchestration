export type WorkerStatus =
  | "running"
  | "waiting_for_lead"
  | "completed"
  | "failed"
  | "cancelled";

export type SubagentNesting =
  | "none"
  | "one-level"
  | "nested"
  | "runtime-defined";

export interface WorkerCapabilities {
  persistentSession: boolean;
  parallelSubagents: boolean;
  subagents: {
    supported: boolean;
    nesting: SubagentNesting;
  };
}

export interface LeadQuestion {
  question: string;
  context?: string;
}

export interface TaskBrief {
  objective: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  relevantFiles?: string[];
  protectedPaths?: string[];
  verificationCommands?: string[];
  context?: string;
  subagentPolicy?: "auto" | "prefer" | "avoid";
}

export interface StartWorkerInput {
  cwd: string;
  brief: TaskBrief;
  model?: string;
}

export interface WorkerSession {
  id: string;
  worker: string;
  nativeSessionId: string;
  cwd: string;
  startedAt: string;
}

export interface WorkerRunResult {
  sessionId: string;
  status: WorkerStatus;
  summary?: string;
  leadQuestion?: LeadQuestion;
  raw?: unknown;
}

export interface WorkerStartResult {
  session: WorkerSession;
  result: WorkerRunResult;
}

export interface WorkerAdapter {
  readonly name: string;
  readonly capabilities: WorkerCapabilities;

  isAvailable(): Promise<boolean>;

  start(input: StartWorkerInput): Promise<WorkerStartResult>;

  followUp(
    session: WorkerSession,
    message: string,
  ): Promise<WorkerRunResult>;

  getResult(session: WorkerSession): Promise<WorkerRunResult>;

  cancel(session: WorkerSession): Promise<void>;
}

const LEAD_QUERY_OPEN = "<orchestration_lead_query>";
const LEAD_QUERY_CLOSE = "</orchestration_lead_query>";

export function renderTaskBrief(brief: TaskBrief): string {
  const sections: string[] = [
    "# Sidekick handoff",
    "",
    "## Objective",
    brief.objective,
  ];

  appendList(sections, "Constraints", brief.constraints);
  appendList(sections, "Acceptance criteria", brief.acceptanceCriteria);
  appendList(sections, "Relevant files", brief.relevantFiles);
  appendList(sections, "Protected paths", brief.protectedPaths);
  appendList(sections, "Verification commands", brief.verificationCommands);

  if (brief.context?.trim()) {
    sections.push("", "## Context", brief.context.trim());
  }

  sections.push(
    "",
    "## Collaboration protocol",
    "You are the persistent Sidekick paired with one Lead for this workspace.",
    "The Lead owns planning, ambiguity, architecture, and final review. You own execution of the current handoff.",
    "Build on your existing context and worktree across handoffs instead of treating each request as a fresh task.",
    "Keep code-writing single-threaded by default. Native subagents may be used for read-only exploration or verification when clearly useful, but do not fan out independent writers unless the Lead explicitly asks.",
    "Do not commit, push, merge, or rewrite git history. Leave changes in this Sidekick worktree for Lead review and guarded integration.",
    "",
    "If you reach a judgment call that can materially change the implementation, do not guess. Stop the current turn and ask the lead by ending your response with exactly:",
    LEAD_QUERY_OPEN,
    '{"question":"the decision you need from the lead","context":"short context and the options you considered"}',
    LEAD_QUERY_CLOSE,
    "",
    "After the lead replies, continue in this same persistent session.",
    "Otherwise, implement the task, run the relevant checks, and report what changed, the relevant diff/result, and what you actually verified. Leave the final commit/integration decision to the Lead.",
  );

  return sections.join("\n");
}

export function renderLeadReply(answer: string): string {
  return [
    "# Lead reply",
    answer.trim(),
    "",
    "Continue the delegated task in this same session. If another material judgment call is required, use the lead-query protocol again.",
  ].join("\n");
}

export function extractLeadQuestion(
  summary: string | undefined,
): LeadQuestion | undefined {
  if (!summary) return undefined;

  const start = summary.lastIndexOf(LEAD_QUERY_OPEN);
  const end = summary.lastIndexOf(LEAD_QUERY_CLOSE);

  if (start === -1 || end === -1 || end <= start) return undefined;

  const json = summary
    .slice(start + LEAD_QUERY_OPEN.length, end)
    .trim();

  try {
    const parsed = JSON.parse(json) as {
      question?: unknown;
      context?: unknown;
    };

    if (typeof parsed.question !== "string" || !parsed.question.trim()) {
      return undefined;
    }

    return {
      question: parsed.question.trim(),
      ...(typeof parsed.context === "string" && parsed.context.trim()
        ? { context: parsed.context.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function appendList(
  sections: string[],
  title: string,
  items: string[] | undefined,
): void {
  if (!items?.length) return;
  sections.push("", `## ${title}`);
  for (const item of items) sections.push(`- ${item}`);
}
