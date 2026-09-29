import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  extractLeadQuestion,
  renderLeadReply,
  type LeadQuestion,
  type TaskBrief,
  type WorkerAdapter,
  type WorkerRunResult,
  type WorkerSession,
} from "@clanov/orchestration-core";
import type { StateStore } from "@clanov/orchestration-state";
import { SqliteStateStore } from "@clanov/orchestration-state";
import {
  GitWorktreeManager,
  type ApplyPreview,
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
  | "applied"
  | "interrupted"
  | "failed"
  | "cancelled";

type RecoverableActiveState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "verifying";

type EventType =
  | "task_queued"
  | "workspace_preparing"
  | "workspace_ready"
  | "worker_starting"
  | "worker_session_ready"
  | "lead_question"
  | "lead_reply"
  | "handoff"
  | "verification_started"
  | "verification_passed"
  | "verification_failed"
  | "apply_prepared"
  | "apply_rejected"
  | "applied"
  | "completed"
  | "recovered_interrupted"
  | "resume_started"
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

interface ApplyPlan {
  id: string;
  createdAt: string;
  preview: ApplyPreview;
}

interface TaskRecord {
  id: string;
  workerName: string;
  worker?: WorkerAdapter;
  model?: string;
  sourceCwd: string;
  brief: TaskBrief;
  state: TaskState;
  interruptedFrom?: RecoverableActiveState;
  createdAt: string;
  updatedAt: string;
  workspace?: WorktreeLease;
  session?: WorkerSession;
  result?: WorkerRunResult;
  verification?: VerificationReport;
  verificationHistory: VerificationReport[];
  applyPlan?: ApplyPlan;
  error?: string;
  cancelRequested: boolean;
  events: TaskEvent[];
  nextSeq: number;
}

interface PersistedWorkerRunResult {
  sessionId: string;
  status: WorkerRunResult["status"];
  summary?: string;
  leadQuestion?: LeadQuestion;
}

interface PersistedTaskRecord {
  version: 1;
  id: string;
  workerName: string;
  model?: string;
  sourceCwd: string;
  brief: TaskBrief;
  state: TaskState;
  interruptedFrom?: RecoverableActiveState;
  createdAt: string;
  updatedAt: string;
  workspace?: WorktreeLease;
  session?: WorkerSession;
  result?: PersistedWorkerRunResult;
  verification?: VerificationReport;
  verificationHistory: VerificationReport[];
  applyPlan?: ApplyPlan;
  error?: string;
  cancelRequested: boolean;
  events: TaskEvent[];
  nextSeq: number;
}

export interface OrchestrationServerOptions {
  workers: WorkerAdapter[];
  workspace?: GitWorktreeManager;
  verifier?: WorktreeVerifier;
  stateStore?: StateStore;
}

export function createOrchestrationServer(
  options: OrchestrationServerOptions,
): McpServer {
  const server = new McpServer({ name: "orchestration", version: "0.5.0" });
  const sidekick = options.workers[0];
  if (!sidekick) throw new Error("orchestration requires one Sidekick runtime.");
  // Fusion-style sessions expose one persistent Sidekick. Additional configured
  // runtimes are fallback candidates selected before the MCP server starts.
  const workers = new Map([[sidekick.name, sidekick]]);
  const tasks = new Map<string, TaskRecord>();
  const workspace = options.workspace ?? new GitWorktreeManager();
  const verifier = options.verifier ?? new WorktreeVerifier(workspace);
  const stateStore = options.stateStore ?? new SqliteStateStore();

  restoreTasks();

  server.registerTool(
    "sidekick_status",
    {
      description:
        "Show the single persistent Sidekick runtime paired with this Lead. Runtime selection is owned by orchestration, not by each handoff.",
      inputSchema: z.object({}),
    },
    async () =>
      toolJson({
        runtime: sidekick.name,
        capabilities: sidekick.capabilities,
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List durable orchestration tasks, including tasks recovered after an MCP restart.",
      inputSchema: z.object({}),
    },
    async () =>
      toolJson(
        [...tasks.values()]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((record) => snapshot(record)),
      ),
  );

  server.registerTool(
    "start_sidekick",
    {
      description:
        "Start the persistent Sidekick for a Lead workspace. Reuse it with handoff instead of spawning a new Sidekick per subtask.",
      inputSchema: z.object({
        cwd: z.string(),
        objective: z.string().min(1),
        constraints: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        relevantFiles: z.array(z.string()).optional(),
        protectedPaths: z.array(z.string()).optional(),
        verificationCommands: z.array(z.string()).optional(),
        context: z.string().optional(),
      }),
    },
    async (input) => {
      const existing = [...tasks.values()].find(
        (record) =>
          record.sourceCwd === input.cwd &&
          record.workspace &&
          record.state !== "applied" &&
          record.state !== "cancelled",
      );
      if (existing) {
        return toolError(
          `A persistent Sidekick already exists for this workspace as task ${existing.id} (${existing.state}). Use handoff/reply_to_sidekick/resume_task with that task instead of starting another writer.`,
        );
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
      };

      const record = createTask(sidekick, input.cwd, brief, undefined);
      tasks.set(record.id, record);
      emit(record, "task_queued", "Persistent Sidekick session queued.");

      void startTask(record);

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "get_result",
    {
      description:
        "Inspect a durable delegated task without blocking, including worktree, verification, recovery, and apply-plan state.",
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
        "Read incremental durable task events while the lead and sidekick run concurrently.",
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
        "Read only the Sidekick-authored delta relative to the Lead snapshot captured at delegation time.",
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
    "resume_task",
    {
      description:
        "Resume a task that was interrupted by an orchestration process restart. Reuses the same worktree and native worker session when available.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        message: z.string().min(1).optional(),
      }),
    },
    async ({ taskId, message }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      if (record.state !== "interrupted") {
        return toolError(
          `Task "${taskId}" is ${record.state}, not interrupted.`,
        );
      }

      const worker = requireWorker(record);
      if (!worker.ok) return toolError(worker.error);

      if (!record.workspace) {
        return toolError(
          "The Sidekick was interrupted before a durable worktree was recorded. Start a fresh Sidekick from the current Lead workspace.",
        );
      }

      delete record.error;
      const interruptedFrom = record.interruptedFrom;
      delete record.interruptedFrom;

      if (interruptedFrom === "verifying" && record.result) {
        record.state = "verifying";
        record.updatedAt = now();
        emit(
          record,
          "resume_started",
          "Restart recovery resumed harness verification.",
        );
        void verifyTask(record);
        return toolJson(snapshot(record));
      }

      record.state = "running";
      record.updatedAt = now();
      emit(
        record,
        "resume_started",
        record.session
          ? "Restart recovery resumed the existing native sidekick session."
          : "Restart recovery is starting a new native sidekick session in the preserved worktree.",
      );

      if (record.session) {
        void continueTask(
          record,
          message ??
            "The orchestration process restarted. Inspect the current worktree, continue from the existing state without redoing completed work, then finish the delegated task and report what you verified.",
        );
      } else {
        void restartWorkerInExistingWorkspace(record);
      }

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "reply_to_sidekick",
    {
      description:
        "Answer a Sidekick judgment question and resume the same persistent native session asynchronously.",
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

      const worker = requireWorker(record);
      if (!worker.ok) return toolError(worker.error);

      invalidateApplyPlan(record);
      record.state = "running";
      record.updatedAt = now();
      emit(record, "lead_reply", "Lead replied to sidekick.");

      void continueTask(record, renderLeadReply(answer));

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "follow_up",
    {
      description:
        "Send the next brief or review feedback to the same persistent Sidekick session and worktree.",
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
          "The Sidekick is still active. Use get_events/get_result while the Lead continues other work.",
        );
      }
      if (record.state === "interrupted") {
        return toolError(
          "The task was interrupted by a process restart. Use resume_task first.",
        );
      }
      if (record.state === "waiting_for_lead") {
        return toolError(
          "The sidekick is waiting for a lead decision. Use reply_to_sidekick.",
        );
      }
      if (record.state === "cancelled") {
        return toolError("Cancelled tasks cannot be resumed.");
      }
      if (record.state === "applied") {
        return toolError(
          "Applied tasks cannot be resumed. Start a new Sidekick from the updated Lead workspace.",
        );
      }

      const worker = requireWorker(record);
      if (!worker.ok) return toolError(worker.error);

      invalidateApplyPlan(record);
      record.state = "running";
      record.updatedAt = now();
      emit(record, "handoff", "Lead sent the next handoff to the persistent Sidekick.");

      void continueTask(record, message);

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "prepare_apply",
    {
      description:
        "Preflight a verified Sidekick delta against the Lead's current workspace without modifying it. Returns an approval plan id and conflict/divergence details.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
      }),
    },
    async ({ taskId }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      if (!record.workspace) {
        return toolError("The isolated worktree is not ready.");
      }
      if (
        record.state !== "completed" ||
        record.verification?.status !== "passed"
      ) {
        return toolError(
          "Only a completed task with a passing harness verification can be prepared for apply.",
        );
      }

      try {
        const preview = await workspace.prepareApply(record.workspace);
        const plan: ApplyPlan = {
          id: randomUUID(),
          createdAt: now(),
          preview,
        };

        record.applyPlan = plan;
        record.updatedAt = now();

        emit(
          record,
          "apply_prepared",
          preview.canApply
            ? "Apply preflight passed; explicit Lead approval is required."
            : "Apply preflight found a conflict; Lead workspace was not modified.",
          {
            planId: plan.id,
            ...preview,
          },
        );

        return toolJson({
          taskId,
          planId: plan.id,
          approvalRequired: true,
          ...preview,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit(record, "apply_rejected", message);
        return toolError(message);
      }
    },
  );

  server.registerTool(
    "apply_to_lead",
    {
      description:
        "Apply a previously preflighted, verified Sidekick delta to the Lead workspace. Requires the exact planId and confirm=true. Refuses stale plans.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        planId: z.string().uuid(),
        confirm: z.literal(true),
      }),
    },
    async ({ taskId, planId }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      if (!record.workspace) {
        return toolError("The isolated worktree is not ready.");
      }
      if (
        record.state !== "completed" ||
        record.verification?.status !== "passed"
      ) {
        return toolError(
          "Only a completed task with a passing harness verification can be applied.",
        );
      }

      const plan = record.applyPlan;
      if (!plan || plan.id !== planId) {
        return toolError(
          "Apply approval plan is missing or does not match. Run prepare_apply again.",
        );
      }

      if (!plan.preview.canApply) {
        return toolError(
          plan.preview.conflictReason ??
            "The prepared Sidekick patch does not apply cleanly.",
        );
      }

      try {
        const result = await workspace.applyPrepared(record.workspace, {
          patchHash: plan.preview.patchHash,
          sourceHead: plan.preview.sourceHead,
          sourceTree: plan.preview.sourceTree,
        });

        delete record.applyPlan;
        record.state = "applied";
        record.updatedAt = now();

        emit(
          record,
          "applied",
          result.applied
            ? "Verified Sidekick delta applied to Lead workspace."
            : "Sidekick produced no delta; nothing needed to be applied.",
          result,
        );

        return toolJson({
          taskId,
          state: record.state,
          ...result,
        });
      } catch (error) {
        delete record.applyPlan;
        const message = error instanceof Error ? error.message : String(error);
        emit(record, "apply_rejected", message);
        return toolError(message);
      }
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
      invalidateApplyPlan(record);
      record.state = "cancelled";
      record.updatedAt = now();
      emit(record, "cancelled", "Cancellation requested.");

      if (record.session && record.worker) {
        await record.worker.cancel(record.session);
      }

      return toolJson(snapshot(record));
    },
  );

  server.registerTool(
    "cleanup",
    {
      description:
        "Remove an inactive task's isolated git worktree after the lead no longer needs its diff. Durable task history is retained.",
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

      invalidateApplyPlan(record);
      await workspace.remove(record.workspace);
      delete record.workspace;
      record.updatedAt = now();
      emit(record, "workspace_cleaned", "Isolated worktree removed.");

      return toolJson({ taskId, cleaned: true });
    },
  );

  server.registerTool(
    "forget_task",
    {
      description:
        "Delete durable history for an inactive task after its worktree has already been cleaned up.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        confirm: z.literal(true),
      }),
    },
    async ({ taskId }) => {
      const record = tasks.get(taskId);
      if (!record) return toolError(`Unknown task "${taskId}".`);
      if (record.workspace) {
        return toolError(
          "Clean up the task worktree before forgetting durable task history.",
        );
      }
      if (
        record.state === "queued" ||
        record.state === "preparing_workspace" ||
        record.state === "running" ||
        record.state === "waiting_for_lead" ||
        record.state === "verifying"
      ) {
        return toolError("Cannot forget an active task.");
      }

      stateStore.delete(taskId);
      tasks.delete(taskId);

      return toolJson({ taskId, forgotten: true });
    },
  );

  return server;

  async function startTask(record: TaskRecord): Promise<void> {
    record.state = "preparing_workspace";
    record.updatedAt = now();
    emit(record, "workspace_preparing", "Preparing isolated git worktree.");

    try {
      const lease = await workspace.prepare(record.id, record.sourceCwd);
      record.workspace = lease;
      record.updatedAt = now();
      emit(record, "workspace_ready", "Isolated git worktree ready.", {
        worktreeRoot: lease.worktreeRoot,
        baseCommit: lease.baseCommit,
        snapshotCommit: lease.snapshotCommit,
        sourceWasDirty: lease.sourceWasDirty,
      });

      if (record.cancelRequested) {
        await workspace.remove(lease);
        delete record.workspace;
        persist(record);
        return;
      }

      record.state = "running";
      record.updatedAt = now();
      emit(record, "worker_starting", "Starting native sidekick session.");

      const worker = requireWorker(record);
      if (!worker.ok) {
        failTask(record, new Error(worker.error));
        return;
      }

      const started = await worker.worker.start({
        cwd: lease.workerCwd,
        brief: record.brief,
        ...(record.model ? { model: record.model } : {}),
      });

      record.session = started.session;
      record.updatedAt = now();
      emit(record, "worker_session_ready", "Native sidekick session ready.", {
        nativeSessionId: started.session.nativeSessionId,
      });

      if (record.cancelRequested) {
        await worker.worker.cancel(started.session);
        return;
      }

      await applyResult(record, started.result);
    } catch (error) {
      failTask(record, error);
    }
  }

  async function restartWorkerInExistingWorkspace(
    record: TaskRecord,
  ): Promise<void> {
    const lease = record.workspace;
    if (!lease) {
      failTask(record, new Error("Missing preserved Sidekick worktree."));
      return;
    }

    const worker = requireWorker(record);
    if (!worker.ok) {
      failTask(record, new Error(worker.error));
      return;
    }

    try {
      const started = await worker.worker.start({
        cwd: lease.workerCwd,
        brief: record.brief,
        ...(record.model ? { model: record.model } : {}),
      });

      record.session = started.session;
      record.updatedAt = now();
      emit(
        record,
        "worker_session_ready",
        "Recovered task started a native sidekick session.",
        { nativeSessionId: started.session.nativeSessionId },
      );

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

    const worker = requireWorker(record);
    if (!worker.ok) {
      failTask(record, new Error(worker.error));
      return;
    }

    try {
      const result = await worker.worker.followUp(session, message);

      if (record.cancelRequested) {
        await worker.worker.cancel(session);
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
    invalidateApplyPlan(record);

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
      emit(record, "lead_question", leadQuestion.question, leadQuestion);
      return;
    }

    record.result = result;

    if (result.status === "failed") {
      record.state = "failed";
      record.updatedAt = now();
      emit(record, "failed", result.summary ?? "Sidekick failed.");
      return;
    }

    if (result.status === "cancelled") {
      record.state = "cancelled";
      record.updatedAt = now();
      emit(record, "cancelled", result.summary ?? "Sidekick cancelled.");
      return;
    }

    await verifyTask(record);
  }

  async function verifyTask(record: TaskRecord): Promise<void> {
    if (!record.workspace) {
      failTask(record, new Error("Cannot verify without an isolated worktree."));
      return;
    }

    invalidateApplyPlan(record);
    record.state = "verifying";
    record.updatedAt = now();
    emit(record, "verification_started", "Harness verification started.");

    try {
      const report = await verifier.verify(record.workspace, record.brief);
      record.verification = report;
      record.verificationHistory.push(report);
      record.updatedAt = now();

      if (report.status === "passed") {
        record.state = "completed";
        emit(
          record,
          "verification_passed",
          "Harness verification passed.",
          report,
        );
        emit(
          record,
          "completed",
          record.result?.summary ?? "Sidekick completed.",
        );
      } else {
        record.state = "verification_failed";
        emit(
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
    invalidateApplyPlan(record);
    const message = error instanceof Error ? error.message : String(error);
    record.error = message;
    record.state = "failed";
    record.updatedAt = now();
    emit(record, "failed", message);
  }

  function restoreTasks(): void {
    for (const row of stateStore.list()) {
      let persisted: PersistedTaskRecord;
      try {
        persisted = JSON.parse(row.payload) as PersistedTaskRecord;
      } catch {
        continue;
      }

      if (persisted.version !== 1 || !persisted.id || !persisted.workerName) {
        continue;
      }

      const worker = workers.get(persisted.workerName);
      const record: TaskRecord = {
        id: persisted.id,
        workerName: persisted.workerName,
        ...(worker ? { worker } : {}),
        ...(persisted.model ? { model: persisted.model } : {}),
        sourceCwd: persisted.sourceCwd,
        brief: persisted.brief,
        state: persisted.state,
        ...(persisted.interruptedFrom
          ? { interruptedFrom: persisted.interruptedFrom }
          : {}),
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        ...(persisted.workspace ? { workspace: persisted.workspace } : {}),
        ...(persisted.session ? { session: persisted.session } : {}),
        ...(persisted.result ? { result: persisted.result } : {}),
        ...(persisted.verification
          ? { verification: persisted.verification }
          : {}),
        verificationHistory: persisted.verificationHistory ?? [],
        ...(persisted.applyPlan ? { applyPlan: persisted.applyPlan } : {}),
        ...(persisted.error ? { error: persisted.error } : {}),
        cancelRequested: persisted.cancelRequested ?? false,
        events: persisted.events ?? [],
        nextSeq: persisted.nextSeq ?? 1,
      };

      tasks.set(record.id, record);

      if (isActiveState(record.state)) {
        const interruptedFrom = record.state;
        record.state = "interrupted";
        record.interruptedFrom = interruptedFrom;
        record.cancelRequested = false;
        delete record.applyPlan;
        record.updatedAt = now();

        emit(
          record,
          "recovered_interrupted",
          "The MCP process stopped while this task was active. The worktree/session metadata was recovered; call resume_task to continue safely.",
          { interruptedFrom },
        );
      }
    }
  }

  function persist(record: TaskRecord): void {
    stateStore.put(
      record.id,
      JSON.stringify(toPersisted(record)),
    );
  }

  function emit(
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
    persist(record);
  }
}

function createTask(
  worker: WorkerAdapter,
  sourceCwd: string,
  brief: TaskBrief,
  model: string | undefined,
): TaskRecord {
  const createdAt = now();
  return {
    id: randomUUID(),
    workerName: worker.name,
    worker,
    ...(model ? { model } : {}),
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

function toPersisted(record: TaskRecord): PersistedTaskRecord {
  const result = record.result
    ? {
        sessionId: record.result.sessionId,
        status: record.result.status,
        ...(record.result.summary
          ? { summary: record.result.summary }
          : {}),
        ...(record.result.leadQuestion
          ? { leadQuestion: record.result.leadQuestion }
          : {}),
      }
    : undefined;

  return {
    version: 1,
    id: record.id,
    workerName: record.workerName,
    ...(record.model ? { model: record.model } : {}),
    sourceCwd: record.sourceCwd,
    brief: record.brief,
    state: record.state,
    ...(record.interruptedFrom
      ? { interruptedFrom: record.interruptedFrom }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.workspace ? { workspace: record.workspace } : {}),
    ...(record.session ? { session: record.session } : {}),
    ...(result ? { result } : {}),
    ...(record.verification ? { verification: record.verification } : {}),
    verificationHistory: record.verificationHistory,
    ...(record.applyPlan ? { applyPlan: record.applyPlan } : {}),
    ...(record.error ? { error: record.error } : {}),
    cancelRequested: record.cancelRequested,
    events: record.events,
    nextSeq: record.nextSeq,
  };
}

function requireWorker(
  record: TaskRecord,
):
  | { ok: true; worker: WorkerAdapter }
  | { ok: false; error: string } {
  if (record.worker) {
    return { ok: true, worker: record.worker };
  }

  return {
    ok: false,
    error:
      `Worker "${record.workerName}" is not configured in this MCP process. ` +
      "Restore its environment/runtime configuration and restart orchestration.",
  };
}

function isActiveState(state: TaskState): state is RecoverableActiveState {
  return (
    state === "queued" ||
    state === "preparing_workspace" ||
    state === "running" ||
    state === "verifying"
  );
}

function invalidateApplyPlan(record: TaskRecord): void {
  delete record.applyPlan;
}

function snapshot(record: TaskRecord) {
  return {
    taskId: record.id,
    worker: record.workerName,
    workerAvailable: Boolean(record.worker),
    state: record.state,
    ...(record.interruptedFrom
      ? { interruptedFrom: record.interruptedFrom }
      : {}),
    capabilities: record.worker?.capabilities ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.workspace
      ? {
          workspace: {
            sourceCwd: record.workspace.sourceCwd,
            worktreeRoot: record.workspace.worktreeRoot,
            workerCwd: record.workspace.workerCwd,
            baseCommit: record.workspace.baseCommit,
            snapshotCommit: record.workspace.snapshotCommit,
            sourceWasDirty: record.workspace.sourceWasDirty,
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
    ...(record.applyPlan
      ? {
          applyPlan: {
            planId: record.applyPlan.id,
            createdAt: record.applyPlan.createdAt,
            ...record.applyPlan.preview,
          },
        }
      : {}),
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
