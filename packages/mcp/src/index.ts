import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type {
  TaskBrief,
  WorkerAdapter,
  WorkerSession,
} from "@clanov/orchestration-core";

interface StoredSession {
  worker: WorkerAdapter;
  session: WorkerSession;
}

export interface OrchestrationServerOptions {
  workers: WorkerAdapter[];
}

export function createOrchestrationServer(
  options: OrchestrationServerOptions,
): McpServer {
  const server = new McpServer({ name: "orchestration", version: "0.0.0" });
  const workers = new Map(options.workers.map((worker) => [worker.name, worker]));
  const sessions = new Map<string, StoredSession>();

  server.registerTool(
    "delegate",
    {
      description:
        "Delegate a bounded coding task to a native worker runtime and keep its session for follow-up turns.",
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
      };

      const started = await worker.start({
        cwd: input.cwd,
        brief,
        ...(input.model ? { model: input.model } : {}),
      });

      sessions.set(started.session.id, { worker, session: started.session });
      return toolJson(started);
    },
  );

  server.registerTool(
    "follow_up",
    {
      description:
        "Send feedback to an existing delegated task while preserving native worker context.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        message: z.string().min(1),
      }),
    },
    async ({ sessionId, message }) => {
      const stored = sessions.get(sessionId);
      if (!stored) return toolError(`Unknown session "${sessionId}".`);
      return toolJson(await stored.worker.followUp(stored.session, message));
    },
  );

  server.registerTool(
    "get_result",
    {
      description: "Inspect the latest result from an existing worker session.",
      inputSchema: z.object({ sessionId: z.string().uuid() }),
    },
    async ({ sessionId }) => {
      const stored = sessions.get(sessionId);
      if (!stored) return toolError(`Unknown session "${sessionId}".`);
      return toolJson(await stored.worker.getResult(stored.session));
    },
  );

  server.registerTool(
    "cancel",
    {
      description: "Abort an existing worker session.",
      inputSchema: z.object({ sessionId: z.string().uuid() }),
    },
    async ({ sessionId }) => {
      const stored = sessions.get(sessionId);
      if (!stored) return toolError(`Unknown session "${sessionId}".`);
      await stored.worker.cancel(stored.session);
      return toolJson({ sessionId, status: "cancelled" });
    },
  );

  return server;
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
