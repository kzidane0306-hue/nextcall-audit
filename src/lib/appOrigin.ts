import "server-only";

/**
 * The public origin the app should call ITSELF on.
 *
 * Behind Render's proxy, request.url is the container's own
 * http://localhost:<port>/ — an internal fetch to that URL never fires, which
 * is exactly how the audit pass's chained send ping and the screenshot
 * ingest's worker kick went dark on Render. Prefer the platform URL
 * (RENDER_EXTERNAL_URL), then the operator-set public URL
 * (NEXT_PUBLIC_APP_URL), and only then fall back to the request origin.
 */
export function selfOrigin(requestOrigin?: string): string {
  const fromEnv = process.env.RENDER_EXTERNAL_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  return (fromEnv || requestOrigin || "").trim().replace(/\/+$/, "");
}
