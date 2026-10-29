import { ProviderRegistry } from "./provider-registry.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
/** No default model, key, price, alternate endpoint, or fallback provider. */
export function createGeminiRegistry(model: string): ProviderRegistry {
  if (!/^gemini-[a-zA-Z0-9_.-]{1,100}$/.test(model)) throw new Error("An explicit Gemini model is required");
  return new ProviderRegistry([{
    id: "gemini", name: "Gemini", baseUrl: GEMINI_BASE_URL, apiKeyEnvVar: "GEMINI_API_KEY",
    enabled: true, priority: 1, maxRequestsPerMinute: 1, maxTokensPerMinute: 8192,
    models: [{ id: model, tier: "fast", contextWindow: 8192, maxOutputTokens: 256,
      // Legacy display estimates are not authoritative. Only the shared
      // operator budget's explicit price authorizes and accounts for requests.
      costPerInputToken: 0, costPerOutputToken: 0,
      supportsTools: false, supportsVision: false, supportsStreaming: false }],
  }]);
}
