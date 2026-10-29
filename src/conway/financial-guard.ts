/** Application guard for the evaluation fork; not an OS or provider budget. */
export function assertFinancialOperationsEnabled(enabled: unknown, operation: string): void {
  if (enabled !== true) {
    throw new Error(`FINANCIAL_OPERATIONS_DISABLED: ${operation} requires explicit operator configuration`);
  }
}
