import { formatRelativeTime } from "@/client/lib/relative-time";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { Input } from "@/client/components/ui/input";
import { REPORT_CSP } from "@/shared/report-sandbox";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { captureClientEvent } from "@/client/lib/posthog";
import {
  deleteReport,
  shareReport,
  getShareReview,
  unshareReport,
  type ReportListItem,
} from "@/serverFunctions/reports";
import { sharePath } from "@/shared/report-share";

// Query keys for the reports and templates pages. staleTime is 0 wherever these are used:
// the pages exist to inspect what an agent just wrote, so the app-wide
// five-minute staleTime would show a pre-save list as current.
export const reportsQueryKey = (projectId: string) =>
  ["reports", projectId] as const;

export const reportQueryKey = (projectId: string, reportId: string) =>
  ["report", projectId, reportId] as const;

export const reportTemplatesQueryKey = (projectId: string) =>
  ["report-templates", projectId] as const;

/**
 * "Ben · Claude Code". The person is the half that means something (it comes
 * from the session); the client half is a self-reported hint, so it stands
 * alone when the user cannot be resolved.
 */
export function formatCreatedBy(report: ReportListItem): string {
  return report.createdByName
    ? `${report.createdByName} · ${report.createdBy}`
    : report.createdBy;
}

/**
 * One delete flow for both the list row and the detail page, so the toast, the
 * event and the invalidation cannot drift apart.
 */
export function useDeleteReport(projectId: string, onDeleted?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reportId: string) =>
      deleteReport({ data: { projectId, reportId } }),
    onSuccess: (_result, reportId) => {
      captureClientEvent("report:deleted", {
        project_id: projectId,
        report_id: reportId,
      });
      toast.success("Report deleted");
      void queryClient.invalidateQueries({
        queryKey: reportsQueryKey(projectId),
      });
      // Drop the detail entry too, or a later visit to that URL renders the
      // deleted report from cache before the refetch turns it into a 404.
      queryClient.removeQueries({
        queryKey: reportQueryKey(projectId, reportId),
      });
      onDeleted?.();
    },
  });
}

/** Reports have no version history and no undo, so deletes are confirmed by name. */
export function DeleteReportModal({
  title,
  isPending,
  onClose,
  onConfirm,
}: {
  title: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Delete \u201c${title}\u201d?`}
      confirmLabel="Delete report"
      destructive
      pending={isPending}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      This cannot be undone.
    </ConfirmDialog>
  );
}

/**
 * Version review and public-link approval. The link is built from the browser's own origin, so the
 * same report shares correctly from app.openseo.so and from a self-hosted
 * hostname without the server knowing either.
 */
export function ShareReportModal({
  report,
  onClose,
}: {
  report: Pick<
    ReportListItem,
    | "id"
    | "projectId"
    | "title"
    | "shareToken"
    | "sharedAt"
    | "revision"
    | "approvedContentHash"
  >;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmedVersion, setConfirmedVersion] = useState<string | null>(null);
  const { projectId, id: reportId } = report;
  const review = useQuery({
    queryKey: ["report-share-review", projectId, reportId, report.revision],
    queryFn: () => getShareReview({ data: { projectId, reportId } }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const reviewVersion = review.data
    ? `${review.data.report.revision}:${review.data.contentHash}`
    : null;
  const confirmed =
    reviewVersion !== null && confirmedVersion === reviewVersion;
  // Share and unshare in one mutation, keyed by the state the toggle is moving
  // to. The response is written straight into the report query so the modal
  // shows the new link without waiting for a refetch; the list is invalidated
  // because its rows carry the same metadata.
  const mutation = useMutation({
    meta: { errorToast: false },
    mutationFn: (shared: boolean) =>
      shared
        ? shareReport({
            data: {
              projectId,
              reportId,
              revision: review.data!.report.revision,
              contentHash: review.data!.contentHash,
            },
          })
        : unshareReport({ data: { projectId, reportId } }),
    onError: () => {
      setConfirmedVersion(null);
      void queryClient.invalidateQueries({
        queryKey: reportQueryKey(projectId, reportId),
      });
      void queryClient.invalidateQueries({
        queryKey: reportsQueryKey(projectId),
      });
    },
    onSuccess: (result) => {
      setConfirmedVersion(null);
      void review.refetch();
      // No client event here: the service already captures report:shared and
      // report:unshared server-side, and a second one would double the count.
      queryClient.setQueryData(
        reportQueryKey(projectId, reportId),
        (previous: ReportListItem | undefined) =>
          previous ? { ...previous, ...result } : previous,
      );
      void queryClient.invalidateQueries({
        queryKey: reportsQueryKey(projectId),
      });
    },
  });
  const shared = Boolean(report.shareToken);
  const url = report.shareToken
    ? `${window.location.origin}${sharePath(report.shareToken)}`
    : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Clipboard not available");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>Share</DialogTitle>
          <DialogDescription className="truncate">
            {report.title}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border">
          <div className="space-y-3 p-4">
            <p className="font-medium">
              {shared ? "Shared approved version" : "Private · awaiting review"}
            </p>
            <p className="text-sm text-muted-foreground">
              Anyone with the public link can read this report without signing
              in. Every save revokes the link and requires a new review.
              Revocation cannot remove copies already downloaded.
            </p>
            {shared ? (
              <>
                <p className="break-all text-xs">
                  Approved revision {report.revision} · SHA-256{" "}
                  {report.approvedContentHash}
                </p>
                <Button
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(false)}
                >
                  {mutation.isPending ? "Revoking…" : "Revoke public link"}
                </Button>
              </>
            ) : review.isPending ? (
              <p role="status">Loading version for review…</p>
            ) : review.isError ? (
              <div role="alert">
                <p>Could not load the review. Sharing remains disabled.</p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfirmedVersion(null);
                    void review.refetch();
                  }}
                >
                  Reload review
                </Button>
              </div>
            ) : review.data ? (
              <>
                <p className="font-medium">{review.data.report.title}</p>
                <p className="text-sm whitespace-pre-wrap">
                  {review.data.report.summary}
                </p>
                <p className="break-all text-xs">
                  Revision {review.data.report.revision} · SHA-256{" "}
                  {review.data.contentHash}
                </p>
                <iframe
                  title="Exact report version for approval"
                  sandbox=""
                  referrerPolicy="no-referrer"
                  className="h-80 w-full border"
                  srcDoc={`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">${review.data.html}`}
                />
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={mutation.isPending}
                    onChange={(event) =>
                      setConfirmedVersion(
                        event.target.checked ? reviewVersion : null,
                      )
                    }
                  />
                  I reviewed the text, facts, sources and publication rights for
                  this version and approve a public link.
                </label>
                <Button
                  disabled={
                    !confirmed || mutation.isPending || review.isFetching
                  }
                  onClick={() => mutation.mutate(true)}
                >
                  {mutation.isPending
                    ? "Confirming…"
                    : "Approve this version and create public link"}
                </Button>
                <Button
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => {
                    setConfirmedVersion(null);
                    void review.refetch();
                  }}
                >
                  Reload review
                </Button>
              </>
            ) : null}
          </div>

          {shared ? (
            <div className="space-y-3 border-t border-border p-4">
              {/* The field wraps onto its own line when the row gets narrow, so
                  the link stays readable on a phone instead of shrinking. */}
              <div className="flex flex-wrap items-stretch gap-2">
                <Input
                  readOnly
                  value={url}
                  aria-label="Share link"
                  onFocus={(event) => event.target.select()}
                  className="min-w-0 flex-1 basis-64"
                />
                <div className="ml-auto flex items-stretch gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    nativeButton={false}
                    aria-label="Open link"
                    title="Open"
                    render={<a href={url} target="_blank" rel="noreferrer" />}
                  >
                    <ExternalLink />
                  </Button>
                  <Button onClick={() => void copy()}>
                    <Copy data-icon="inline-start" />
                    Copy link
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Shows only this approved revision. Saving revokes the link.
                Hidden from search engines.
                {report.sharedAt
                  ? ` Link created ${formatRelativeTime(report.sharedAt)}.`
                  : ""}
              </p>
            </div>
          ) : null}
        </div>

        {/* Shown in place rather than as a toast: the message belongs next to
            the action that failed. */}
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {getStandardErrorMessage(
              mutation.error,
              "Sharing status is uncertain. Reload the review and check the current state before trying again.",
            )}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
