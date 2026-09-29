export type WorkerStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskBrief {
  objective: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  relevantFiles?: string[];
  protectedPaths?: string[];
  verificationCommands?: string[];
  context?: string;
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
  raw?: unknown;
}

export interface WorkerStartResult {
  session: WorkerSession;
  result: WorkerRunResult;
}

export interface WorkerAdapter {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  start(input: StartWorkerInput): Promise<WorkerStartResult>;
  followUp(session: WorkerSession, message: string): Promise<WorkerRunResult>;
  getResult(session: WorkerSession): Promise<WorkerRunResult>;
  cancel(session: WorkerSession): Promise<void>;
}

export function renderTaskBrief(brief: TaskBrief): string {
  const sections: string[] = [
    "# Delegated task",
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
    "Implement the task in the current workspace. Keep the change scoped to the brief. Report what changed and what you actually verified.",
  );

  return sections.join("\n");
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
