/**
 * Surf Wala — Chat utility helpers
 *
 * Pure functions with no React or component dependencies.
 * Extracted from chat-demo.tsx to keep that file focused on UI and flow logic.
 */

import { getSeasonalPerNightPrice } from "@/lib/pricing";

// ── Date utilities ────────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD using LOCAL components (never UTC).
 *  Avoids the classic toISOString() bug that shifts dates by a day for
 *  users in positive UTC-offset timezones. */
export function formatDateLocal(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dy}`;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatDateLocal(d);
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const diff = Math.round(
    (new Date(checkOut + "T00:00:00").getTime() - new Date(checkIn + "T00:00:00").getTime())
    / (1000 * 60 * 60 * 24)
  );
  return diff > 0 ? diff : 1;
}

// ── Room helpers ──────────────────────────────────────────────────────────────

/** How many rooms a group of adults needs (2 per room). */
export function calcRooms(adults: number): { rooms: number; hasExtra: boolean } {
  if (adults <= 1) return { rooms: 1, hasExtra: false };
  return { rooms: Math.floor(adults / 2), hasExtra: adults % 2 !== 0 };
}

/** Display label for a room option with seasonal per-night price. */
export function formatRoomOption(
  a: { name: string; type: string },
  dateStr: string
): string {
  return `${a.name} - ${getSeasonalPerNightPrice(a.type, dateStr).toLocaleString()} Rs/night`;
}

// ── Course helpers ────────────────────────────────────────────────────────────

export function formatCourseOption(c: { name: string; price: number }): string {
  return `${c.name} - ${c.price.toLocaleString()} Rs`;
}

/** Put Private Lesson first; keep original order otherwise. */
export function sortCoursesPrivateFirst<T extends { type: string }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    a.type === "private" ? -1 : b.type === "private" ? 1 : 0
  );
}

// ── Network ───────────────────────────────────────────────────────────────────

export async function safeFetchJson(
  input: RequestInfo,
  init?: RequestInit
): Promise<{ ok: boolean; data: any }> {
  const res  = await fetch(input, init);
  const text = await res.text();
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch { /* leave null */ } }
  return { ok: res.ok, data };
}

// ── Validation ────────────────────────────────────────────────────────────────

export const isValidEmail = (e: string) => e.includes("@") && e.includes(".");
