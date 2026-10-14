import { z } from "zod";
import { readTextUpTo } from "./html-response";
import { AppError } from "@/server/lib/errors";
import { crawlerHeadersFor, type CrawlerAccess } from "@/shared/crawler-access";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
];

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.includes("%")) {
    host = host.split("%", 1)[0];
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host;
}

function isPrivateIpv4(host: string): boolean {
  const parts = normalizeHost(host)
    .split(".")
    .map((x) => Number(x));
  if (
    parts.length !== 4 ||
    parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true;
  if (a === 192 && b === 2) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseMappedIpv4FromIpv6(host: string): string | null {
  const normalized = normalizeHost(host);
  if (!normalized.startsWith("::ffff:")) return null;

  const mapped = normalized.slice("::ffff:".length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
    return mapped;
  }

  const segments = mapped.split(":").filter(Boolean);
  if (segments.length !== 2) return null;

  const high = Number.parseInt(segments[0], 16);
  const low = Number.parseInt(segments[1], 16);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }

  const a = (high >> 8) & 0xff;
  const b = high & 0xff;
  const c = (low >> 8) & 0xff;
  const d = low & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function isPrivateIpv6(host: string): boolean {
  const value = normalizeHost(host);
  if (value === "::1" || value === "::") return true;
  if (
    value.startsWith("ff") ||
    value.startsWith("64:ff9b:") ||
    value.startsWith("2002:") ||
    value.startsWith("2001:db8:")
  )
    return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  ) {
    return true;
  }

  const mappedIpv4 = parseMappedIpv4FromIpv6(value);
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) {
    return true;
  }

  return false;
}

function isIpLiteral(host: string): boolean {
  const normalized = normalizeHost(host);
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) || normalized.includes(":");
}

function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  if (isIpLiteral(host)) {
    return isPrivateIpv4(host) || isPrivateIpv6(host);
  }

  return false;
}

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

const dnsJsonResponseSchema = z.object({
  Status: z.number(),
  Answer: z
    .array(
      z.object({ type: z.number().optional(), data: z.string().optional() }),
    )
    .optional(),
});

async function resolveAddressRecords(
  hostname: string,
  type: "A" | "AAAA",
): Promise<string[]> {
  const response = await fetch(
    `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
    {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(2_500),
    },
  );

  if (!response.ok) throw new Error("DNS resolution unavailable");

  const body = dnsJsonResponseSchema.parse(
    JSON.parse(await readTextUpTo(response, 64 * 1024)),
  );
  if (body.Status !== 0) throw new Error("DNS resolution failed");
  if (!body.Answer) return [];
  if (!Array.isArray(body.Answer)) throw new Error("Invalid DNS response");

  const expectedType = type === "A" ? 1 : 28;
  return body.Answer.filter(
    (answer): answer is Required<Pick<DnsJsonAnswer, "data" | "type">> =>
      answer.type === expectedType && typeof answer.data === "string",
  ).map((answer) => {
    const data = answer.data.trim();
    if (type === "A" && !/^\d+\.\d+\.\d+\.\d+$/.test(data))
      throw new Error("Invalid IPv4 answer");
    const parsed = new URL(
      type === "AAAA" ? `http://[${data}]` : `http://${data}`,
    );
    return normalizeHost(parsed.hostname);
  });
}

async function hostnameResolvesToBlockedAddress(
  hostname: string,
): Promise<boolean> {
  const host = normalizeHost(hostname);
  if (!host || isIpLiteral(host)) return false;

  try {
    const [v4, v6] = await Promise.all([
      resolveAddressRecords(host, "A"),
      resolveAddressRecords(host, "AAAA"),
    ]);

    const addresses = [...v4, ...v6];
    if (addresses.length === 0) return true;

    return addresses.some(
      (address) =>
        !isIpLiteral(address) ||
        isPrivateIpv4(address) ||
        isPrivateIpv6(address),
    );
  } catch {
    return true;
  }
}

/**
 * Synchronous prefilter for URLs discovered mid-crawl (links, redirect
 * targets, sitemap entries). Blocks non-http(s) schemes, private/loopback IP
 * literals, and internal hostnames. Fetch entrypoints also resolve DNS before
 * sending requests. DNS validation does not replace network-level egress controls.
 */
export function isCrawlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return (
    !parsed.username && !parsed.password && !isBlockedHost(parsed.hostname)
  );
}

export async function normalizeAndValidateStartUrl(
  input: string,
): Promise<string> {
  let raw = input.trim();
  if (!raw) throw new AppError("VALIDATION_ERROR");

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("VALIDATION_ERROR");
  }

  if (parsed.username || parsed.password || isBlockedHost(parsed.hostname)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }

  if (await hostnameResolvesToBlockedAddress(parsed.hostname)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }

  parsed.hash = "";
  return parsed.toString();
}

const START_URL_REDIRECT_HOPS = 5;
const START_URL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Follow redirects on the audit's start URL so the audit anchors to the
 * site's real origin. Without this, auditing a domain that 301s elsewhere
 * (…net -> …com, apex -> www) dead-ends after one page: the redirect target
 * is a different origin, so the same-origin crawl policy can't follow it.
 *
 * Every hop re-runs the full start-URL validation (SSRF, blocked hosts), so
 * a redirect can't smuggle the audit somewhere the user couldn't have
 * pointed it directly. Probe failures (timeouts, HEAD rejected) fall back
 * to the last validated URL — the crawl records the real fetch result.
 *
 * Also reports the final response's `powered-by` header, which is how a
 * Shopify storefront identifies itself.
 */
export async function resolveStartUrlRedirects(
  startUrl: string,
  access?: CrawlerAccess | null,
): Promise<{ url: string; poweredBy: string | null }> {
  let current = startUrl;
  for (let hop = 0; hop < START_URL_REDIRECT_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: {
          "User-Agent": "OpenSEO-Audit/1.0",
          ...crawlerHeadersFor(current, access),
        },
        signal: AbortSignal.timeout(START_URL_PROBE_TIMEOUT_MS),
      });
    } catch {
      return { url: current, poweredBy: null };
    }
    if (response.status < 300 || response.status >= 400) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }
    const location = response.headers.get("location");
    if (!location) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { url: current, poweredBy: null };
    }
    current = await normalizeAndValidateStartUrl(next.toString());
  }
  return { url: current, poweredBy: null };
}
