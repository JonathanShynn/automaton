import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { ChatMessage, InferenceClient, InferenceToolCall } from "../types.js";
import { GlobalBudgetError, requireInferenceBudget, type InferenceBudgetExecutor } from "./global-budget.js";
import { GEMINI_BASE_URL } from "./gemini.js";

const allowed = new Set(["remember_fact", "recall_facts", "sleep"]);

/** JSON action protocol for the bounded research loop, not native function calling.
 * Tool history is rendered as text: no Gemini thought signatures are discarded
 * or synthesized. No transport retry, provider/model fallback or arbitrary URL.
 */
export function createGeminiResearchInference(model: string, sharedBudget: InferenceBudgetExecutor): InferenceClient {
  const budget = requireInferenceBudget(sharedBudget);
  if (!/^gemini-[a-zA-Z0-9_.-]{1,100}$/.test(model)) throw new GlobalBudgetError("Explicit Gemini model required");
  const key = process.env.GEMINI_API_KEY;
  if (!key?.trim()) throw new GlobalBudgetError("Gemini key missing");
  const client = new OpenAI({ apiKey: key, baseURL: GEMINI_BASE_URL, maxRetries: 0, timeout: 60_000 });
  return {
    getDefaultModel: () => model,
    setLowComputeMode: () => {}, // Never silently switch provider or model.
    async chat(messages, options) {
      if (options?.stream || (options?.model && options.model !== model) ||
          options?.tools?.some(tool => !allowed.has(tool.function.name))) {
        throw new GlobalBudgetError("Unsupported research inference options");
      }
      const offered = new Set(options?.tools?.map(tool => tool.function.name) ?? []);
      const textMessages: ChatMessage[] = messages.map(message => ({
        role: message.role === "tool" ? "user" : message.role,
        content: message.role === "tool" ? `Local tool result (${message.tool_call_id}): ${message.content}`
          : `${message.content ?? ""}${message.tool_calls ? `\nPrevious local actions: ${JSON.stringify(message.tool_calls)}` : ""}`,
      }));
      const payload = { model, messages: [
        { role: "system", content: 'Return only a JSON object {"content":"brief analysis","actions":[{"name":"tool name","arguments":{}}]}. At most 3 actions. Use only the offered local tools; never invent tools. Tools: ' + JSON.stringify(options?.tools ?? []) },
        ...textMessages,
      ], response_format: { type: "json_object" } };
      return budget.run({ provider: "gemini", model, payload, maxOutputTokens: options?.maxTokens, actor: "research-parent" }, async limit => {
        let failureShape = 0;
        let failureCode = 1; // 1 transport, 2 incomplete, 3 JSON, 4 schema, 5 action
        try {
          const completion = await client.chat.completions.create({ ...payload, max_tokens: limit, stream: false } as any);
          failureCode = 2;
          const raw = completion.choices[0]?.message?.content;
          if (completion.choices[0]?.finish_reason !== "stop" || !raw) throw new Error("Incomplete response");
          failureCode = 3;
          const parsed = JSON.parse(raw);
          failureShape = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? 1 : 0)
            + (Array.isArray(parsed?.actions) ? 2 : 0) + (typeof parsed?.content === "string" ? 4 : 0)
            + (Array.isArray(parsed) ? 8 : 0) + (Array.isArray(parsed?.tool_calls) ? 16 : 0);
          failureCode = 4;
          if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length > 3) throw new Error("Invalid research response");
          failureCode = 5;
          const calls: InferenceToolCall[] = parsed.actions.map((action: any) => {
            if (!action || !offered.has(action.name) || !allowed.has(action.name) ||
                !action.arguments || typeof action.arguments !== "object" || Array.isArray(action.arguments)) throw new Error("Unapproved action");
            return { id: randomUUID(), type: "function", function: { name: action.name, arguments: JSON.stringify(action.arguments) } };
          });
          const usage = { promptTokens: completion.usage?.prompt_tokens ?? 0,
            completionTokens: completion.usage?.completion_tokens ?? 0, totalTokens: completion.usage?.total_tokens ?? 0 };
          return { id: completion.id, model, message: { role: "assistant" as const, content: typeof parsed.content === "string" ? parsed.content : "", tool_calls: calls },
            toolCalls: calls.length ? calls : undefined, usage, finishReason: "stop" };
        } catch {
          // SDK errors may echo credentials or payloads; stop instead of logging them.
          throw new GlobalBudgetError(`Gemini research request failed [code=${failureCode}] [shape=${failureShape}]; operator review required`);
        }
      }, result => ({ inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens }));
    },
  };
}
