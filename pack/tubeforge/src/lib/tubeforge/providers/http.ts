// Shared fetch plumbing for the non-Z.ai provider adapters — URL joining,
// timeouts, and readable errors (status + body snippet) so users can debug
// 401s / wrong endpoints straight from the activity feed.

const TIMEOUT_MS = 300_000; // 5 min — long LLM and image calls are normal

export function joinUrl(baseUrl: string, ...path: string[]): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  for (const p of path) url += `/${p.replace(/^\/+/, "")}`;
  return url;
}

export class ProviderHttpError extends Error {
  constructor(
    public provider: string,
    public status: number,
    body: string
  ) {
    super(
      `${provider} request failed (HTTP ${status}): ${body.slice(0, 300)}`
    );
    this.name = "ProviderHttpError";
  }
}

export async function providerFetch(
  provider: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`${provider} request timed out after 5 minutes (${url})`);
    }
    throw new Error(
      `${provider} request failed: ${err instanceof Error ? err.message : String(err)} (${url})`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderHttpError(provider, response.status, body);
  }
  return response;
}

export async function providerFetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit
): Promise<T> {
  const response = await providerFetch(provider, url, init);
  return (await response.json()) as T;
}
