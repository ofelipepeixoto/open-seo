import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverUrls } from "@/server/lib/audit/discovery";
import { shopifyCrawlerHeaders } from "@/shared/crawler-access";

const access = {
  host: "store.example.com",
  headers: shopifyCrawlerHeaders("sig1=(...)", "sig1=:abc:"),
  expiresAt: null,
};

/** The `signature` header sent on the request to `url`, or undefined. */
function signatureSentTo(url: string) {
  const call = vi.mocked(fetch).mock.calls.find((entry) => entry[0] === url);
  return call && new Headers(call[1]?.headers).get("signature");
}

describe("discoverUrls crawler access", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops the signature when robots.txt redirects to another host", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      if (
        String(input instanceof Request ? input.url : input).includes(
          "dns-query",
        )
      )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Status: 0,
              Answer: [{ type: 1, data: "93.184.216.34" }],
            }),
          ),
        );
      if (input === "https://store.example.com/robots.txt") {
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { location: "https://cdn.other.test/robots.txt" },
          }),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    await discoverUrls("https://store.example.com", 10, access);

    expect(signatureSentTo("https://store.example.com/robots.txt")).toBe(
      access.headers.Signature,
    );
    expect(signatureSentTo("https://cdn.other.test/robots.txt")).toBeNull();
  });
});
