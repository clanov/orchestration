export type ProviderId = "google" | "openai" | "openrouter";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  envVar: string;
  kind: "api-key";
}

export interface ProviderCredentialStatus extends ProviderDefinition {
  configured: boolean;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "google",
    label: "Gemini API",
    envVar: "GEMINI_API_KEY",
    kind: "api-key",
  },
  {
    id: "openai",
    label: "OpenAI API",
    envVar: "OPENAI_API_KEY",
    kind: "api-key",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    kind: "api-key",
  },
] as const;

export function detectProviderCredentials(
  env: NodeJS.ProcessEnv = process.env,
): ProviderCredentialStatus[] {
  return PROVIDERS.map((provider) => ({
    ...provider,
    configured: Boolean(env[provider.envVar]?.trim()),
  }));
}
