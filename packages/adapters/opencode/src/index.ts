import { randomUUID } from "node:crypto";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
  renderTaskBrief,
  type StartWorkerInput,
  type WorkerAdapter,
  type WorkerCapabilities,
  type WorkerRunResult,
  type WorkerSession,
  type WorkerStartResult,
} from "@clanov/orchestration-core";

export interface OpenCodeWorkerOptions {
  baseUrl?: string;
  providerID: string;
  modelID: string;
  agent?: string;
}

interface MessageEnvelope {
  parts?: Array<{ type?: string; text?: string }>;
}

export class OpenCodeWorker implements WorkerAdapter {
  readonly name = "opencode";

  readonly capabilities: WorkerCapabilities = {
    persistentSession: true,
    parallelSubagents: true,
    subagents: {
      supported: true,
      nesting: "runtime-defined",
    },
  };

  private readonly client;
  private readonly options: OpenCodeWorkerOptions & { baseUrl: string };

  constructor(options: OpenCodeWorkerOptions) {
    this.options = {
      ...options,
      baseUrl: options.baseUrl ?? "http://127.0.0.1:4096",
    };

    this.client = createOpencodeClient({
      baseUrl: this.options.baseUrl,
      throwOnError: true,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(
        new URL("/global/health", this.options.baseUrl),
        {
          method: "GET",
          signal: AbortSignal.timeout(5_000),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async start(input: StartWorkerInput): Promise<WorkerStartResult> {
    const created = unwrapResponse<{ id: string }>(
      await this.client.session.create({
        body: { title: `orchestration: ${input.brief.objective.slice(0, 80)}` },
        query: { directory: input.cwd },
      }),
    );

    const session: WorkerSession = {
      id: randomUUID(),
      worker: this.name,
      nativeSessionId: created.id,
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
    };

    const result = await this.prompt(
      created.id,
      renderTaskBrief(input.brief),
      input.model,
      input.cwd,
    );

    return {
      session,
      result: { ...result, sessionId: session.id },
    };
  }

  async followUp(
    session: WorkerSession,
    message: string,
  ): Promise<WorkerRunResult> {
    const result = await this.prompt(
      session.nativeSessionId,
      message,
      undefined,
      session.cwd,
    );

    return { ...result, sessionId: session.id };
  }

  async getResult(session: WorkerSession): Promise<WorkerRunResult> {
    const messages = unwrapResponse<unknown[]>(
      await this.client.session.messages({
        path: { id: session.nativeSessionId },
        query: { directory: session.cwd },
      }),
    );

    const last = messages.at(-1);

    const summary = extractText(last);

    return {
      sessionId: session.id,
      status: "completed",
      ...(summary ? { summary } : {}),
      raw: last,
    };
  }

  async cancel(session: WorkerSession): Promise<void> {
    await this.client.session.abort({
      path: { id: session.nativeSessionId },
      query: { directory: session.cwd },
    });
  }

  private async prompt(
    nativeSessionId: string,
    prompt: string,
    modelOverride: string | undefined,
    cwd: string,
  ): Promise<Omit<WorkerRunResult, "sessionId">> {
    const model = splitModelOverride(
      modelOverride,
      this.options.providerID,
      this.options.modelID,
    );

    try {
      const response = await this.client.session.prompt({
        path: { id: nativeSessionId },
        query: { directory: cwd },
        body: {
          model,
          ...(this.options.agent ? { agent: this.options.agent } : {}),
          parts: [{ type: "text", text: prompt }],
        },
      });

      const summary = extractText(response);

      return {
        status: "completed",
        ...(summary ? { summary } : {}),
        raw: response,
      };
    } catch (error) {
      return {
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        raw: error,
      };
    }
  }
}

function splitModelOverride(
  value: string | undefined,
  providerID: string,
  modelID: string,
): { providerID: string; modelID: string } {
  if (!value) return { providerID, modelID };
  const slash = value.indexOf("/");
  if (slash === -1) return { providerID, modelID: value };
  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  };
}

function unwrapResponse<T>(value: unknown): T {
  if (
    value &&
    typeof value === "object" &&
    "data" in value &&
    (value as { data?: unknown }).data !== undefined
  ) {
    return (value as { data: T }).data;
  }
  return value as T;
}

function extractText(value: unknown): string | undefined {
  const unwrapped = unwrapResponse<MessageEnvelope>(value);
  if (!unwrapped?.parts?.length) return undefined;

  const text = unwrapped.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text || undefined;
}
