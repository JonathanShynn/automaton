import type { InferenceBudgetExecutor } from "../inference/global-budget.js";
/** Only for existing mocked SDK transport tests. Never import from production. */
export const TEST_TRANSPORT_BUDGET: InferenceBudgetExecutor = {
  run: async (request, call) => call(request.maxOutputTokens as number),
};
