import type { Client } from "@libsql/client";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ReportRepository } from "./ReportRepository";
import { ReportService } from "../services/ReportService";

const state = vi.hoisted(() => ({ client: null as Client | null }));
vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  state.client = createClient({ url: "file::memory:" });
  return { db: drizzle(state.client) };
});
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => true,
}));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));

beforeAll(async () => {
  await state.client!.executeMultiple(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT, domain TEXT, archived_at TEXT);
    INSERT INTO projects VALUES ('project_1', 'org_1', 'example.com', NULL);
    CREATE TABLE reports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      summary TEXT NOT NULL, html TEXT NOT NULL, skill TEXT, template_id TEXT,
      created_by TEXT NOT NULL, created_by_user_id TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      share_token TEXT UNIQUE, shared_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
      approved_content_hash TEXT, approved_by_user_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
});
afterAll(() => state.client!.close());
beforeEach(async () => {
  await state.client!.execute("DELETE FROM reports");
  await ReportRepository.insertReport({
    id: "report_1",
    projectId: "project_1",
    title: "SEO audit",
    summary: "Review this",
    html: "<html><body>Original</body></html>",
    skill: null,
    templateId: null,
    createdBy: "Agent",
    createdByUserId: "user_1",
    sizeBytes: 34,
  });
});
const params = {
  projectId: "project_1",
  reportId: "report_1",
  userId: "user_1",
  organizationId: "org_1",
  source: "app" as const,
};
async function reviewed() {
  const data = await ReportService.getShareReview(
    params.projectId,
    params.reportId,
  );
  return { revision: data.report.revision, contentHash: data.contentHash };
}
async function save() {
  return ReportService.saveReport({
    ...params,
    title: "Changed",
    summary: "Changed",
    html: "<html><body>Changed</body></html>",
    createdBy: "Agent",
    createdByUserId: "user_1",
  });
}
describe("review-bound sharing with real SQLite queries", () => {
  it("stores the human identity and hash and serves exactly that document", async () => {
    const review = await reviewed();
    const published = await ReportService.shareReport({ ...params, review });
    expect(published.approvedByUserId).toBe("user_1");
    expect(published.approvedContentHash).toBe(review.contentHash);
    const publicReport = await ReportRepository.getSharedReportByToken(
      published.shareToken!,
    );
    expect(publicReport?.html).toBe("<html><body>Original</body></html>");
  });
  it("revokes the link atomically when content changes", async () => {
    const published = await ReportService.shareReport({
      ...params,
      review: await reviewed(),
    });
    await save();
    expect(
      await ReportRepository.getSharedReportByToken(published.shareToken!),
    ).toBeNull();
    expect(
      await ReportRepository.getReport("project_1", "report_1"),
    ).toMatchObject({
      revision: 2,
      shareToken: null,
      approvedContentHash: null,
    });
  });
  it("rejects a review after a save", async () => {
    const review = await reviewed();
    await save();
    await expect(
      ReportService.shareReport({ ...params, review }),
    ).rejects.toThrow("changed");
  });
  it("rejects replay after revocation even while private", async () => {
    const review = await reviewed();
    await ReportService.unshareReport(params);
    await expect(
      ReportService.shareReport({ ...params, review }),
    ).rejects.toThrow("revoked");
  });
  it("rejects a forged hash", async () => {
    await expect(
      ReportService.shareReport({
        ...params,
        review: { revision: 1, contentHash: "0".repeat(64) },
      }),
    ).rejects.toThrow("changed");
  });
  it("rejects agent approval even with a valid review", async () => {
    await expect(
      ReportService.shareReport({
        ...params,
        source: "mcp",
        review: await reviewed(),
      }),
    ).rejects.toThrow("Agents cannot");
  });
  it("does not authorize another project", async () => {
    await expect(
      ReportService.shareReport({
        ...params,
        projectId: "project_2",
        review: await reviewed(),
      }),
    ).rejects.toThrow("No report");
  });
  it("compare-and-set refuses a save racing with approval", async () => {
    const review = await reviewed();
    const original = ReportRepository.setShareToken;
    vi.spyOn(ReportRepository, "setShareToken").mockImplementationOnce(
      async (...args) => {
        await save();
        return original(...args);
      },
    );
    await expect(
      ReportService.shareReport({ ...params, review }),
    ).rejects.toThrow("state changed");
    expect(
      (await ReportRepository.getReport("project_1", "report_1"))?.shareToken,
    ).toBeNull();
  });
  it("does not serve legacy tokens without approval", async () => {
    await state.client!.execute("UPDATE reports SET share_token = 'legacy'");
    expect(await ReportRepository.getSharedReportByToken("legacy")).toBeNull();
  });
});

it("migrates existing SQLite reports to private reviews without deleting content", async () => {
  const { createClient } = await import("@libsql/client");
  const { readFile } = await import("node:fs/promises");
  const migrationDb = createClient({ url: "file::memory:" });
  try {
    await migrationDb.executeMultiple(
      "CREATE TABLE reports (id TEXT, html TEXT, share_token TEXT, shared_at TEXT); INSERT INTO reports VALUES ('old', '<html>kept</html>', 'old-token', 'old-time');",
    );
    const migration = await readFile(
      new URL(
        "../../../../../drizzle/sqlite/0056_reviewed_sharing.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await migrationDb.executeMultiple(migration);
    const result = await migrationDb.execute("SELECT * FROM reports");
    expect(result.rows[0]).toMatchObject({
      id: "old",
      html: "<html>kept</html>",
      share_token: null,
      shared_at: null,
      revision: 1,
      approved_content_hash: null,
    });
  } finally {
    migrationDb.close();
  }
});
