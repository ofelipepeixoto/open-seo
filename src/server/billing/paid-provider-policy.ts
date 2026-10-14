import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";

/** No self-host reservation ledger exists yet. BYOK is not a spending limit. */
export async function requirePaidProviderBudget(): Promise<void> {
  if (!(await isHostedServerAuthMode())) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Paid research is disabled in shared/local workspaces until an atomic budget reservation and reconciliation ledger is configured. No provider request was sent.",
    );
  }
}
