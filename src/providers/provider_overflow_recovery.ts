import type { ProviderName } from "./types.js";
import type { ProviderOverflowRecovery } from "./provider_overflow_recovery_helpers.js";
import { claudeOverflowRecovery } from "./overflow_recovery/claude.js";
import { codexOverflowRecovery } from "./overflow_recovery/codex.js";
import { mockOverflowRecovery } from "./overflow_recovery/mock.js";

const OVERFLOW_RECOVERY_BY_PROVIDER: Record<ProviderName, ProviderOverflowRecovery> = {
  claude: claudeOverflowRecovery,
  codex: codexOverflowRecovery,
  mock: mockOverflowRecovery,
};

export function getProviderOverflowRecovery(providerName: ProviderName): ProviderOverflowRecovery {
  return OVERFLOW_RECOVERY_BY_PROVIDER[providerName];
}
