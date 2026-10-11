import { assertTarget, type NetworkPolicy } from "./network.js";
/**
 * Lightweight reachability probe. Unlike send_request this does not require a
 * matching operation; it confirms the local backend is up before testing.
 */

export interface PingResult {
  url: string;
  reachable: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  latencyMs: number;
  error?: string;
}

export async function pingTarget(
  rawUrl: string,
  timeoutMs: number,
  policy: NetworkPolicy = {},
): Promise<PingResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: rawUrl, reachable: false, latencyMs: 0, error: "Invalid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      url: rawUrl,
      reachable: false,
      latencyMs: 0,
      error: "Only http and https targets are supported.",
    };
  }

  await assertTarget(rawUrl, policy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type");
    await response.body?.cancel();
    return {
      url: rawUrl,
      reachable: true,
      status: response.status,
      statusText: response.statusText,
      ...(contentType ? { contentType } : {}),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return {
      url: rawUrl,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: aborted
        ? `Timed out after ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
