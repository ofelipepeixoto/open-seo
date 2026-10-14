import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { requirePaidProviderBudget } from "./paid-provider-policy";
import { dataforseoGet } from "@/server/lib/dataforseo/core";
import { buildChatAgentModel } from "@/server/lib/openrouter";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(),
  getRequiredEnvValue: vi.fn(async () => "fixture-key"),
}));
beforeEach(() => {
  vi.mocked(isHostedServerAuthMode).mockResolvedValue(false);
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
it("refuses a self-host paid DataForSEO call before network access", async () => {
  await expect(dataforseoGet("/v3/test", {})).rejects.toThrow(
    "Paid research is disabled",
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("refuses a self-host LLM call before provider access", async () => {
  await expect(
    generateText({
      model: buildChatAgentModel("fixture-key", "minimax/minimax-m3"),
      prompt: "fixture",
      maxRetries: 0,
    }),
  ).rejects.toThrow("Paid research is disabled");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not turn an unavailable mode lookup into permission", async () => {
  vi.mocked(isHostedServerAuthMode).mockRejectedValue(new Error("unavailable"));
  await expect(requirePaidProviderBudget()).rejects.toThrow("unavailable");
  expect(fetch).not.toHaveBeenCalled();
});
it("leaves hosted calls subject to the existing billing contract", async () => {
  vi.mocked(isHostedServerAuthMode).mockResolvedValue(true);
  await expect(requirePaidProviderBudget()).resolves.toBeUndefined();
});
