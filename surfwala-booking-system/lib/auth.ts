/**
 * Simple admin authentication helpers.
 *
 * The admin password is read from the ADMIN_PASSWORD environment variable
 * (never hard-coded). The session cookie does NOT contain the password itself:
 * it stores a SHA-256 hash derived from the password, so the password cannot
 * be read from the browser. Uses the Web Crypto API, which works both in the
 * Edge runtime (middleware) and in Node.js (API routes).
 */

export const ADMIN_COOKIE = "admin_session";

export async function getAdminSessionToken(): Promise<string | null> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;

  const data = new TextEncoder().encode(`surfwala-admin-session:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
