import { afterEach, expect, it, vi } from "vitest";
import { discoverUrls } from "./discovery";
afterEach(() => vi.unstubAllGlobals());
it("stops consuming oversized robots during streaming", async () => {
  let chunks = 0;
  let cancelled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.includes("dns-query"))
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "93.184.216.34" }],
        });
      if (!input.endsWith("robots.txt"))
        return new Response(null, { status: 404 });
      return new Response(
        new ReadableStream({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(128 * 1024).fill(32));
            if (chunks === 8) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }),
  );
  await discoverUrls("https://example.com", 1);
  expect(chunks).toBeLessThan(8);
  expect(cancelled).toBe(true);
});
it("does not fetch a redirect destination whose DNS is private", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.includes("dns-query"))
        return Response.json({
          Status: 0,
          Answer: [
            {
              type: 1,
              data: input.includes("private.example")
                ? "10.0.0.1"
                : "93.184.216.34",
            },
          ],
        });
      if (input.endsWith("robots.txt"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.example/robots.txt" },
        });
      return new Response(null, { status: 404 });
    }),
  );
  await discoverUrls("https://example.com", 1);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([input]) =>
        String(input instanceof Request ? input.url : input).startsWith(
          "https://private.example/",
        ),
      ),
  ).toBe(false);
});
