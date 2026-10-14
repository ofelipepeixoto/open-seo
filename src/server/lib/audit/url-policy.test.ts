import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@/server/lib/errors";
import {
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
} from "@/server/lib/audit/url-policy";

describe("normalizeAndValidateStartUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds https when protocol is missing and strips hash", async () => {
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ type: 1, data: "93.184.216.34" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/dns-json" },
          },
        ),
    );

    await expect(
      normalizeAndValidateStartUrl("example.com/path#section"),
    ).resolves.toBe("https://example.com/path");
  });

  it.each(["http://localhost:3000", "http://192.168.0.10"])(
    "blocks %s",
    async (url) => {
      await expect(normalizeAndValidateStartUrl(url)).rejects.toMatchObject({
        code: "CRAWL_TARGET_BLOCKED",
      } satisfies Partial<AppError>);
    },
  );
});

const dnsOk = () =>
  new Response(
    JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }),
    {
      status: 200,
      headers: { "content-type": "application/dns-json" },
    },
  );
const redirect = (location: string) =>
  new Response(null, { status: 301, headers: { location } });

describe("resolveStartUrlRedirects", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Route probe fetches by URL; DoH lookups always resolve clean. */
  function stubFetch(routes: Record<string, () => Response>) {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("dns-query")) return Promise.resolve(dnsOk());
      const route = routes[url];
      return route
        ? Promise.resolve(route())
        : Promise.resolve(new Response(null, { status: 200 }));
    });
  }

  it("follows a cross-domain redirect to the real origin", async () => {
    stubFetch({
      "https://example.net/": () => redirect("https://example.com/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.net/"),
    ).resolves.toMatchObject({ url: "https://example.com/" });
  });

  it("returns the last URL when the probe fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).resolves.toMatchObject({ url: "https://example.com/" });
  });

  it("stops after the hop limit on a redirect loop", async () => {
    stubFetch({
      "https://a.example/": () => redirect("https://b.example/"),
      "https://b.example/": () => redirect("https://a.example/"),
    });
    const resolved = await resolveStartUrlRedirects("https://a.example/");
    expect(resolved.url).toMatch(/^https:\/\/(a|b)\.example\/$/);
  });

  it("rejects redirects into blocked targets", async () => {
    stubFetch({
      "https://example.com/": () => redirect("http://192.168.0.10/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<AppError>);
  });
});

describe("fail-closed DNS admission", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    { Status: 2 },
    { Status: 0, Answer: [] },
    {
      Status: 0,
      Answer: [
        { type: 1, data: "93.184.216.34" },
        { type: 28, data: "fd00::1" },
      ],
    },
  ])("refuses unresolved or mixed private results: %j", async (body) => {
    vi.mocked(fetch).mockImplementation(async () => Response.json(body));
    await expect(
      normalizeAndValidateStartUrl("https://example.com"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });
  it("refuses resolver transport failure", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));
    await expect(
      normalizeAndValidateStartUrl("https://example.com"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });
  it.each([
    "https://user:secret@example.com",
    "http://[ff02::1]",
    "http://[64:ff9b::a00:1]",
  ])("refuses %s before resolving", async (url) => {
    await expect(normalizeAndValidateStartUrl(url)).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
