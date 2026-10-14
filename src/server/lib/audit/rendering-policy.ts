import {
  getOptionalEnvValue,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";

// Rendering works when a renderer exists. Alchemy deployments (hosted,
// previews, self-hosted Cloudflare) bind Browser Run to the audit worker and
// set AUDIT_BROWSER_RENDERING on the app worker; local development sets the
// same flag to attach a remote browser. Docker and legacy Wrangler installs
// have no browser, so they render only through a Context.dev key.
// Hosted accounts pay for rendering with usage credits; self-hosted operators
// require a reservation ledger before paid rendering can be enabled.
export async function isAuditRenderingAllowed(): Promise<boolean> {
  if (!(await isHostedServerAuthMode())) return false;
  if (await getOptionalEnvValue("CONTEXT_API_KEY")) return true;
  return (await getOptionalEnvValue("AUDIT_BROWSER_RENDERING")) === "true";
}
