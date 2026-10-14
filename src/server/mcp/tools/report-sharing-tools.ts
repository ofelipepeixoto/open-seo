import { z } from "zod";
import { ReportService } from "@/server/features/reports/services/ReportService";
import { sharesEnabled } from "@/server/features/reports/shareAccess";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { buildDashboardUrl } from "@/server/mcp/urls";
import { sharePath } from "@/shared/report-share";
import type { ReportMetadata } from "@/types/schemas/reports";

export async function reportShareUrl(report: ReportMetadata, baseUrl: string) {
  return report.shareToken && (await sharesEnabled())
    ? buildDashboardUrl(baseUrl, sharePath(report.shareToken))
    : null;
}

// -------------------------------------------------------- set_report_sharing

const sharingInputSchema = {
  projectId: projectIdSchema,
  reportId: z
    .string()
    .min(1)
    .describe("Report id from list_reports or save_report."),
  public: z
    .boolean()
    .describe(
      "Only false is permitted for agents: revoke the public link. Enabling sharing requires a human to review and approve the exact version in the app.",
    ),
} as const;

export const setReportSharingTool = {
  name: "set_report_sharing",
  config: {
    title: "Set report sharing",
    description:
      "Revokes public sharing for one saved report. Uses no credits. Agents cannot enable public sharing; direct the user to the app sharing dialog to review and approve the exact version. Saving a report revokes its previous public link. Returns the app url and shareUrl.",
    inputSchema: sharingInputSchema,
    outputSchema: z.looseObject({
      reportId: z.string(),
      public: z.boolean(),
      url: z.string(),
      shareUrl: z.string().nullable(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof sharingInputSchema>>, context) => {
      const params = {
        projectId: args.projectId,
        reportId: args.reportId,
        userId: context.auth.userId,
        organizationId: context.auth.organizationId,
        source: "mcp" as const,
      };
      const report = args.public
        ? await ReportService.shareReport(params)
        : await ReportService.unshareReport(params);
      const path = `/p/${args.projectId}/reports/${report.id}`;
      const url = buildDashboardUrl(context.baseUrl, path);
      const shareUrl = await reportShareUrl(report, context.baseUrl);

      return mcpResponse({
        text: shareUrl
          ? `Public sharing enabled. Anyone with this link can read the approved report revision without an account: ${shareUrl}`
          : `Public sharing disabled. The report is private. Open it at ${url}.`,
        meta: buildProjectMeta(context, args.projectId, path),
        structuredContent: {
          reportId: report.id,
          public: shareUrl !== null,
          url,
          shareUrl,
        },
      });
    },
  ),
};
