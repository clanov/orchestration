import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  extractLeadQuestion,
  renderLeadReply,
  type TaskBrief,
  type WorkerAdapter,
  type WorkerRunResult,
  type WorkerSession,
} from "@clanov/orchestration-core";
import {
  GitWorktreeManager,
  type WorktreeLease,
} from "@clanov/orchestration-workspace";
import {
  WorktreeVerifier,
  type VerificationReport,
} from "@clanov/orchestration-verifier";

type TaskState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "waiting_for_lead"
  | "verifying"
  | "verification_failed"
  | "completed"
  | "failed"
  | "cancelled";

type EventType =
  | "task_queued"
  | "workspace_preparing"
  | "workspace_ready"
  | "worker_session_ready"
  | "lead_question"
  | "lead_reply"
  | "follow_up"
  | "verification_started"
  | "verification_passed"
  | "verification_failed"
  | "completed"
  | "failed"
  | "cancelled"
  | "workspace_cleaned";

interface TaskEvent {
  seq: number;
  type: EventType;
  at: string;
  message?: string;
  data?: unknown;
}

interface TaskRecord {
  id: string;
  worker: WorkerAdapter;
  sourceCwd: string;
  brief: TaskBrief;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  workspace?: WorktreeLease;
  session?: WorkerSession;
  result?: WorkerRunResult;
  verification?: VerificationReport;
  verificationHistory: VerificationReport[];
  error?: string;
  cancelRequested: boolean;
  events: TaskEvent[];
  nextSeq: number;
}

export interface OrchestrationServerOptions {
  workers: WorkerAdapter[];
  workspace?: GitWorktreeManager;
  verifier?: WorktreeVerifier;
}

export function createOrchestrationServer(
  options: OrchestrationServerOptions,
): McpServer {
  const server = new McpServer({ name: "orchestration", version: "0.2.0" });
  const workers = new Map(options.workers.map((worker) => [worker.name, worker]));
  const tasks = new Map<string, TaskRecord>();
  const workspace = options.workspace ?? new GitWorktreeManager();
  const verifier = options.verifier ?? new WorktreeVerifier(workspace);

  server.registerTool(
    "list_workers",
    {
      description:
        "List configured sidekick runtimes and their persistent-session/subagent capabilities.",
      inputSchema: z.object({}),
    },
    async () =>
      toolJson(
        [...workers.values()].map((worker) => ({
          name: worker.name,
          capabilities: worker.capabilities,
        })),
      ),
  );

  server.registerTool(
    "delegate",
    {
      description:
        "Start a sidekick asynchronously in an isolated git worktree. Returns a taskId immediately so the lead can keep working in parallel.",
      inputSchema: z.object({
        worker: z.string(),
        cwd: z.string(),
        model: z.string().optional(),
        objective: z.string().min(1),
        constraints: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        relevantFiles: z.array(z.string()).optional(),
        protectedPaths: z.array(z.string()).optional(),
        verificationCommands: z.array(z.string()).optional(),
        context: z.string().optional(),
        subagentPolicy: z.enum(["auto", "prefer", "avoid"]).optional(),
      }),
    },
    async (input) => {
      const worker = workers.get(input.worker);
      if (!worker) {
        return toolError(
          `Unknown worker "${input.worker}". Available workers: ${[
            ...workers.keys(),
          ].join(", ")}`,
        );
      }

      if (!(await worker.isAvailable())) {
        return toolError(`Worker "${worker.name}" is not available.`);
      }

      const brief: TaskBrief = {
        objective: input.objective,
        ...(input.constraints ? { constraints: input.constraints } : {}),
        ...(input.acceptanceCriteria
          ? { acceptanceCriteria: input.acceptanceCriteria }
          : {}),
        ...(input.relevantFiles ? { relevantFiles: input.relevantFiles } : {}),
        ...(input.protectedPaths ? { protectedPaths: input.protectedPaths } : {}),
        ...(input.verificationCommands
          ? { verificationCommands: input.verificationCommands }
          : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.subagentPolicy
          ? { subagentPolicy: input.subagentPolicy }
          : {}),
      };

      const record = createTask(worker, input.cwd, brief);
      tasks.set(record.id, record);
      pushEvent(record, "task_queued", "Sidekick task queued.");

      void startTask(record, input.model);

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "get_result",
    {
      description:
        "Inspect a delegated task without blocking, including worktree and verification state.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
      }),
    },
    async ({ taskId }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "get_events",
    {
      description:
        "Read incremental task events while the lead and sidekick run concurrently.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        after: z.number().int().nonnegative().optional(),
      }),
    },
    async ({ taskId, after }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);

      const cursor = after ?? 0;
      return toolJson({
        taskId,
        state: record.state,
        events: record.events.filter((event) => event.seq > cursor),
        nextCursor: record.events.at(-1)?.seq ?? cursor,
      });
    },
  );

  server.registerTool(
    "get_diff",
    {
      description:
        "Read the isolated sidekick worktree diff for lead review. The patch is truncated by default; changed/untracked files are always listed.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        maxPatchChars: z.number().int().min(0).max(200_000).optional(),
      }),
    },
    async ({ taskId, maxPatchChars }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      if (!record.workspace) {
        return toolError("The isolated worktree is not ready yet.");
      }

      return toolJson(
        await workspace.inspect(
          record.workspace,
          maxPatchChars ?? 40_000,
        ),
      );
    },
  );

  server.registerTool(
    "reply_to_worker",
    {
      description:
        "Answer a sidekick judgment question and resume the same persistent worker session asynchronously.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        answer: z.string().min(1),
      }),
    },
    async ({ taskId, answer }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      if (!record.session) {
        return toolError("The sidekick session is not ready yet.");
      }
      if (record.state !== "waiting_for_lead") {
        return toolError(
          `Task "${taskId}" is ${record.state}, not waiting_for_lead.`,
        );
      }

      pushEvent(record, "lead_reply", "Lead replied to sidekick.");
      record.state = "running";
      record.updatedAt = now();

      void continueTask(record, renderLeadReply(answer));

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "follow_up",
    {
      description:
        "Send feedback to a completed or verification-failed sidekick and resume the same native session asynchronously.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        message: z.string().min(1),
      }),
    },
    async ({ taskId, message }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      if (!record.session) {
        return toolError("The sidekick session is not ready yet.");
      }
      if (
        record.state === "running" ||
        record.state === "queued" ||
        record.state === "preparing_workspace" ||
        record.state === "verifying"
      ) {
        return toolError(
          "The sidekick task is still active. Use get_events/get_result while the lead continues other work.",
        );
      }
      if (record.state === "waiting_for_lead") {
        return toolError(
          "The sidekick is waiting for a lead decision. Use reply_to_worker.",
        );
      }
      if (record.state === "cancelled") {
        return toolError("Cancelled tasks cannot be resumed.");
      }

      pushEvent(record, "follow_up", "Lead sent follow-up feedback.");
      record.state = "running";
      record.updatedAt = now();

      void continueTask(record, message);

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Cancel a delegated sidekick task. The isolated worktree is preserved for inspection until cleanup.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
      }),
    },
    async ({ taskId }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);

      record.cancelRequested = true;
      record.state = "cancelled";
      record.updatedAt = now();
      pushEvent(record, "cancelled", "Cancellation requested.");

      if (record.session) {
        await record.worker.cancel(record.session);
      }

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "cleanup",
    {
      description:
        "Remove an inactive task's isolated git worktree after the lead no longer needs its diff.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
      }),
    },
    async ({ taskId }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      if (
        record.state === "queued" ||
        record.state === "preparing_workspace" ||
        record.state === "running" ||
        record.state === "waiting_for_lead" ||
        record.state === "verifying"
      ) {
        return toolError("Cannot clean up an active task.");
      }
      if (!record.workspace) {
        return toolJson({ taskId, cleaned: false, reason: "no-worktree" });
      }

      await workspace.remove(record.workspace);
      record.workspace = undefined;
      record.updatedAt = now();
      pushEvent(record, "workspace_cleaned", "Isolated worktree removed.");

      return toolJson({ taskId, cleaned: true });
    },
  );

  return server;

  async function startTask(
    record: TaskRecord,
    model: string | undefined,
  ): Promise<void> {
    record.state = "preparing_workspace";
    record.updatedAt = now();
    pushEvent(record, "workspace_preparing", "Preparing isolated git worktree.");

    try {
      const lease = await workspace.prepare(record.id, record.sourceCwd);
      record.workspace = lease;
      record.updatedAt = now();
      pushEvent(record, "workspace_ready", "Isolated git worktree ready.", {
        worktreeRoot: lease.worktreeRoot,
        baseCommit: lease.baseCommit,
      });

      if (record.cancelRequested) {
        await workspace.remove(lease);
        record.workspace = undefined;
        return;
      }

      record.state = "running";
      const started = await record.worker.start({
        cwd: lease.workerCwd,
        brief: record.brief,
        ...(model ? { model } : {}),
      });

      record.session = started.session;
      pushEvent(record, "worker_session_ready", "Native sidekick session ready.", {
        nativeSessionId: started.session.nativeSessionId,
      });

      if (record.cancelRequested) {
        await record.worker.cancel(started.session);
        return;
      }

      await applyResult(record, started.result);
    } catch (error) {
      failTask(record, error);
    }
  }

  async function continueTask(
    record: TaskRecord,
    message: string,
  ): Promise<void> {
    const session = record.session;
    if (!session) {
      failTask(record, new Error("Missing native sidekick session."));
      return;
    }

    try {
      const result = await record.worker.followUp(session, message);

      if (record.cancelRequested) {
        await record.worker.cancel(session);
        return;
      }

      await applyResult(record, result);
    } catch (error) {
      failTask(record, error);
    }
  }

  async function applyResult(
    record: TaskRecord,
    result: WorkerRunResult,
  ): Promise<void> {
    const leadQuestion =
      result.leadQuestion ?? extractLeadQuestion(result.summary);

    if (leadQuestion) {
      record.result = {
        ...result,
        status: "waiting_for_lead",
        leadQuestion,
      };
      record.state = "waiting_for_lead";
      record.updatedAt = now();
      pushEvent(record, "lead_question", leadQuestion.question, leadQuestion);
      return;
    }

    record.result = result;

    if (result.status === "failed") {
      record.state = "failed";
      record.updatedAt = now();
      pushEvent(record, "failed", result.summary ?? "Sidekick failed.");
      return;
    }

    if (result.status === "cancelled") {
      record.state = "cancelled";
      record.updatedAt = now();
      pushEvent(record, "cancelled", result.summary ?? "Sidekick cancelled.");
      return;
    }

    await verifyTask(record);
  }

  async function verifyTask(record: TaskRecord): Promise<void> {
    if (!record.workspace) {
      failTask(record, new Error("Cannot verify without an isolated worktree."));
      return;
    }

    record.state = "verifying";
    record.updatedAt = now();
    pushEvent(record, "verification_started", "Harness verification started.");

    try {
      const report = await verifier.verify(record.workspace, record.brief);
      record.verification = report;
      record.verificationHistory.push(report);
      record.updatedAt = now();

      if (report.status === "passed") {
        record.state = "completed";
        pushEvent(record, "verification_passed", "Harness verification passed.", report);
        pushEvent(record, "completed", record.result?.summary ?? "Sidekick completed.");
      } else {
        record.state = "verification_failed";
        pushEvent(
          record,
          "verification_failed",
          "Harness verification failed. The lead can inspect the report and follow up in the same sidekick session.",
          report,
        );
      }
    } catch (error) {
      failTask(record, error);
    }
  }

  function failTask(record: TaskRecord, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    record.error = message;
    record.state = "failed";
    record.updatedAt = now();
    pushEvent(record, "failed", message);
  }
}

function createTask(
  worker: WorkerAdapter,
  sourceCwd: string,
  brief: TaskBrief,
): TaskRecord {
  const createdAt = now();
  return {
    id: randomUUID(),
    worker,
    sourceCwd,
    brief,
    state: "queued",
    createdAt,
    updatedAt: createdAt,
    cancelRequested: false,
    verificationHistory: [],
    events: [],
    nextSeq: 1,
  };
}

function pushEvent(
  record: TaskRecord,
  type: EventType,
  message?: string,
  data?: unknown,
): void {
  record.events.push({
    seq: record.nextSeq++,
    type,
    at: now(),
    ...(message ? { message } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}

function snapshot(record: TaskRecord) {
  return {
    taskId: record.id,
    worker: record.worker.name,
    state: record.state,
    capabilities: record.worker.capabilities,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.workspace
      ? {
          workspace: {
            sourceCwd: record.workspace.sourceCwd,
            worktreeRoot: record.workspace.worktreeRoot,
            workerCwd: record.workspace.workerCwd,
            baseCommit: record.workspace.baseCommit,
          },
        }
      : {}),
    ...(record.session
      ? {
          sessionId: record.session.id,
          nativeSessionId: record.session.nativeSessionId,
        }
      : {}),
    ...(record.result ? { result: record.result } : {}),
    ...(record.verification ? { verification: record.verification } : {}),
    ...(record.error ? { error: record.error } : {}),
    latestEventSeq: record.events.at(-1)?.seq ?? 0,
  };
}

function now(): string {
  return new Date().toISOString();
}

function toolJson(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
