/**
 * Surf Wala — Seasonal Pricing
 *
 * ROOM AVAILABILITY uses 4 distinct room types (physically different rooms,
 * different inventory counts): fan | ac | premium_fan | premium_ac.
 *
 * PRICING: premium_fan and premium_ac ALWAYS cost the same (shared "Premium"
 * price tier) — this is a deliberate business rule. To avoid the two ever
 * drifting apart, SEASONS keeps all 4 keys internally (so existing lookups
 * like season.perNight[roomKey] keep working unchanged), but the admin-facing
 * API/dashboard only exposes ONE "premium" row per season. Saving that one
 * row writes the same price into both premium_fan and premium_ac here.
 */

import { courses } from "@/lib/mock-data";
import type { RoomKeyType } from "@/lib/types";

export type RoomKey = RoomKeyType; // "fan" | "ac" | "premium_fan" | "premium_ac"
export type SeasonName = "peaceful" | "loafer" | "busy" | "blackout";

export interface SeasonDef {
  name: SeasonName;
  label: string;
  ranges: { startM: number; startD: number; endM: number; endD: number }[];
  extraBedPerNight: number;
  rooms: Partial<Record<RoomKey, true>>;
  packagePrices: Record<RoomKey, { 3?: number; 5?: number; 7?: number }>;
  perNight: Record<RoomKey, number>;
}

export let SEASONS: SeasonDef[] = [
  {
    name: "peaceful",
    label: "Peaceful Season",
    ranges: [
      { startM: 10, startD: 1,  endM: 11, endD: 15 },
      { startM: 2,  startD: 16, endM: 4,  endD: 30 },
    ],
    extraBedPerNight: 1000,
    rooms: { fan: true, ac: true, premium_fan: true, premium_ac: true },
    packagePrices: {
      fan:         { 3: 15300, 5: 22950, 7: 29500 },
      ac:          { 3: 18000, 5: 27200, 7: 35000 },
      premium_fan: { 3: 20700, 5: 31450, 7: 40000 },
      premium_ac:  { 3: 20700, 5: 31450, 7: 40000 },
    },
    perNight: { fan: 3000, ac: 4000, premium_fan: 5000, premium_ac: 5000 },
  },
  {
    name: "loafer",
    label: "Loafer Season",
    ranges: [{ startM: 5, startD: 1, endM: 9, endD: 31 }],
    extraBedPerNight: 1000,
    rooms: { ac: true, premium_fan: true, premium_ac: true }, // no Fan in low season
    packagePrices: {
      fan:         {},
      ac:          { 3: 15000, 5: 22200, 7: 30000 },
      premium_fan: { 3: 17700, 5: 26450, 7: 35000 },
      premium_ac:  { 3: 17700, 5: 26450, 7: 35000 },
    },
    perNight: { fan: 0, ac: 2000, premium_fan: 3000, premium_ac: 3000 },
  },
  {
    name: "busy",
    label: "Busy Season",
    ranges: [
      { startM: 11, startD: 16, endM: 12, endD: 19 },
      { startM: 1,  startD: 8,  endM: 2,  endD: 15 },
    ],
    extraBedPerNight: 1000,
    rooms: { fan: true, ac: true, premium_fan: true, premium_ac: true },
    packagePrices: {
      fan:         { 3: 18000, 5: 27200, 7: 35200 },
      ac:          { 3: 20700, 5: 31450, 7: 40800 },
      premium_fan: { 3: 23400, 5: 35700, 7: 46400 },
      premium_ac:  { 3: 23400, 5: 35700, 7: 46400 },
    },
    perNight: { fan: 4000, ac: 5000, premium_fan: 6000, premium_ac: 6000 },
  },
  {
    name: "blackout",
    label: "Dec 20 – Jan 7 (No Surf + Stay packages)",
    ranges: [{ startM: 12, startD: 20, endM: 1, endD: 7 }],
    extraBedPerNight: 0,
    rooms: {},
    packagePrices: { fan: {}, ac: {}, premium_fan: {}, premium_ac: {} },
    perNight: { fan: 5000, ac: 6000, premium_fan: 7000, premium_ac: 7000 },
  },
];

export const PACKAGE_EXTRA_PERSON_COURSE_PRICE: Record<3 | 5 | 7, number> = {
  3: Math.round(8000  * 0.90), // 7 200 Rs
  5: Math.round(12000 * 0.85), // 10 200 Rs
  7: Math.round(16000 * 0.80), // 12 800 Rs
};

export const ROOM_LABELS: Record<RoomKey, string> = {
  fan:         "Fan Room",
  ac:          "AC Room",
  premium_fan: "Premium Fan Room",
  premium_ac:  "Premium AC Room",
};

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateInRange(
  m: number, d: number,
  r: { startM: number; startD: number; endM: number; endD: number }
): boolean {
  const md = m * 100 + d;
  const s  = r.startM * 100 + r.startD;
  const e  = r.endM   * 100 + r.endD;
  return s <= e ? md >= s && md <= e : md >= s || md <= e;
}

export function getSeasonForDate(dateStr: string): SeasonDef {
  const [, mm, dd] = dateStr.split("-").map(Number);
  return SEASONS.find((s) => s.ranges.some((r) => dateInRange(mm, dd, r))) ?? SEASONS[0];
}

export const isSurfAndStayBlackout = (dateStr: string) =>
  getSeasonForDate(dateStr).name === "blackout";

// ── Room type mapping ─────────────────────────────────────────────────────────
// DB accommodation_types table uses: standard | superior | premium_fan | premium_ac
// Our internal availability keys:     fan      | ac       | premium_fan | premium_ac

export function accTypeToRoomKey(dbType: string): RoomKey {
  if (dbType === "superior")    return "ac";
  if (dbType === "premium_fan") return "premium_fan";
  if (dbType === "premium_ac")  return "premium_ac";
  if (dbType === "ac")          return "ac";
  if (dbType === "fan")         return "fan";
  // Legacy "premium" before migration → default to premium_ac
  if (dbType === "premium")     return "premium_ac";
  return "fan"; // "standard" or unknown
}

export function getSeasonalPerNightPrice(dbType: string, dateStr: string): number {
  return getSeasonForDate(dateStr).perNight[accTypeToRoomKey(dbType)] ?? 0;
}

// ── Per-night season-aware pricing ───────────────────────────────────────────
// When a stay crosses a season boundary, every night is priced by ITS OWN
// season's rate (e.g. 2 nights Peaceful + 3 nights Busy) — fair and transparent
// instead of locking the whole stay to the check-in date's season.

// Local date helper (kept here to avoid a circular import with chat-helpers)
function addDaysLocal(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dy}`;
}

export interface StayPriceBreakdownRow {
  seasonName: SeasonName;
  seasonLabel: string;
  nights: number;
  perNight: number;
  subtotal: number;
}

export interface StayPriceResult {
  total: number;
  nights: number;
  spansSeasons: boolean;
  breakdown: StayPriceBreakdownRow[];
}

/** Accommodation price for a stay: checkIn (inclusive) → checkOut (exclusive),
 *  each night billed at its own season's per-night rate for the room type. */
export function calcStayPrice(dbType: string, checkIn: string, checkOut: string): StayPriceResult {
  const roomKey = accTypeToRoomKey(dbType);
  const breakdown: StayPriceBreakdownRow[] = [];
  let total = 0;
  let nights = 0;

  let cursor = checkIn;
  while (cursor < checkOut && nights < 366) { // hard cap guards against bad input
    const season = getSeasonForDate(cursor);
    const perNight = season.perNight[roomKey] ?? 0;
    const last = breakdown[breakdown.length - 1];
    if (last && last.seasonName === season.name && last.perNight === perNight) {
      last.nights += 1;
      last.subtotal += perNight;
    } else {
      breakdown.push({ seasonName: season.name, seasonLabel: season.label, nights: 1, perNight, subtotal: perNight });
    }
    total += perNight;
    nights += 1;
    cursor = addDaysLocal(cursor, 1);
  }

  return { total, nights, spansSeasons: breakdown.length > 1, breakdown };
}

/** Extra-bed cost for a stay, per-night by each night's season rate. */
export function calcExtraBedPrice(checkIn: string, checkOut: string): number {
  let total = 0;
  let cursor = checkIn;
  let guard = 0;
  while (cursor < checkOut && guard < 366) {
    total += getSeasonForDate(cursor).extraBedPerNight;
    cursor = addDaysLocal(cursor, 1);
    guard++;
  }
  return total;
}

/** A room type is bookable for a stay only if EVERY night's season offers it
 *  (perNight > 0). Prevents e.g. a Fan room on a stay that spans into Loafer
 *  season, where Fan rooms aren't offered at all. */
export function isRoomOfferedForStay(dbType: string, checkIn: string, checkOut: string): boolean {
  const roomKey = accTypeToRoomKey(dbType);
  let cursor = checkIn;
  let guard = 0;
  while (cursor < checkOut && guard < 366) {
    if ((getSeasonForDate(cursor).perNight[roomKey] ?? 0) <= 0) return false;
    cursor = addDaysLocal(cursor, 1);
    guard++;
  }
  return true;
}

/** Blended Surf+Stay package ROOM price when the package spans seasons:
 *  each night contributes (that season's package price / days). Returns null
 *  if ANY night's season doesn't offer this room type for this package length
 *  (e.g. Fan room on a package running into Loafer season). */
export function calcPackageRoomPrice(roomKey: RoomKey, startDate: string, days: 3 | 5 | 7): { total: number; spansSeasons: boolean } | null {
  let total = 0;
  const seasonNames = new Set<SeasonName>();
  for (let i = 0; i < days; i++) {
    const season = getSeasonForDate(addDaysLocal(startDate, i));
    const bundle = season.packagePrices[roomKey]?.[days];
    if (!bundle) return null; // this room/package not offered in a season the range touches
    total += bundle / days;
    seasonNames.add(season.name);
  }
  return { total: Math.round(total), spansSeasons: seasonNames.size > 1 };
}


// ── Package price calculation ─────────────────────────────────────────────────

export interface PackagePriceResult {
  season: SeasonDef;
  spansSeasons: boolean;
  roomTotal: number;
  swimmerExtra: number;
  nonSwimmerExtra: number;
  kidsExtra: number;
  surfExtraTotal: number;
  total: number;
}

export function calcPackagePrice(data: {
  packageDays?: number;
  packageRoomCount?: number;
  packageRoomTypes?: RoomKey[];
  packageRoomType?: RoomKey;
  packageWantsExtraBed?: boolean;
  date?: string;
  surfPeople?: number;
  packageSurfingCount?: number; // how many of the group actually surf (may be less than surfPeople)
  numberOfKids?: number;
  numberOfNonSwimmers?: number;
}): PackagePriceResult {
  const days      = (data.packageDays ?? 3) as 3 | 5 | 7;
  const roomCount = data.packageRoomCount ?? 1;
  const roomTypes: RoomKey[] =
    data.packageRoomTypes?.length
      ? data.packageRoomTypes
      : Array.from({ length: roomCount }, () => data.packageRoomType ?? "fan");

  const now = new Date();
  const startDate = data.date ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const season = getSeasonForDate(startDate); // start-date season, kept for label display

  // Per-night blended room pricing: each night contributes its own season's
  // (package price / days). Falls back to start-season bundle if a night's
  // season doesn't offer the type (shouldn't happen — room selection filters it).
  let spansSeasons = false;
  let roomTotal = roomTypes.reduce((s, rt) => {
    const blended = calcPackageRoomPrice(rt, startDate, days);
    if (blended) {
      if (blended.spansSeasons) spansSeasons = true;
      return s + blended.total;
    }
    return s + (season.packagePrices[rt]?.[days] ?? 0);
  }, 0);
  if (data.packageWantsExtraBed) {
    // Extra bed billed per night at each night's season rate
    roomTotal += calcExtraBedPrice(startDate, addDaysLocal(startDate, days));
  }

  // Only people who actually surf count toward the free-slot / extra-charge
  // calculation — someone staying at the resort without surfing costs nothing extra.
  const totalPeople  = data.packageSurfingCount ?? data.surfPeople ?? 1;
  const kids         = data.numberOfKids        ?? 0;
  const nonSwimmers  = data.numberOfNonSwimmers ?? 0;
  const swimmers     = Math.max(0, totalPeople - kids - nonSwimmers);

  // Each room booked = 1 Surf+Stay package = 1 free surf course included.
  // 2 rooms → 2 free surfers, not 1 (previously hardcoded to 1 regardless of roomCount).
  const freeSlots = roomCount;
  const freeSwimmers    = Math.min(freeSlots, swimmers);
  const remainingFree   = freeSlots - freeSwimmers;
  const freeNonSwimmers = Math.min(remainingFree, nonSwimmers);
  const freeKids        = Math.min(remainingFree - freeNonSwimmers, kids);

  const payingSwimmers    = swimmers    - freeSwimmers;
  const payingNonSwimmers = nonSwimmers - freeNonSwimmers;
  const payingKids        = kids        - freeKids;

  const kidsCourse    = courses.find((c) => c.type === "kids");
  const privateCourse = courses.find((c) => c.type === "private");
  const extraPrice    = PACKAGE_EXTRA_PERSON_COURSE_PRICE[days];

  const kidsExtra       = payingKids        > 0 && kidsCourse    ? kidsCourse.price    * payingKids        : 0;
  const nonSwimmerExtra = payingNonSwimmers > 0 && privateCourse ? privateCourse.price * payingNonSwimmers : 0;
  const swimmerExtra    = payingSwimmers    > 0                   ? extraPrice          * payingSwimmers    : 0;
  const surfExtraTotal  = kidsExtra + nonSwimmerExtra + swimmerExtra;

  return { season, spansSeasons, roomTotal, swimmerExtra, nonSwimmerExtra, kidsExtra, surfExtraTotal, total: roomTotal + surfExtraTotal };
}

// ── Live pricing refresh ──────────────────────────────────────────────────────
// The DB/dashboard only stores ONE "premium" row per season (not separate
// premium_fan/premium_ac rows) — see app/api/seasonal-pricing/route.ts.
// When applying it here, write the same numbers into BOTH premium_fan and
// premium_ac so every existing season.perNight[roomKey] / packagePrices[roomKey]
// lookup throughout the codebase keeps working without any further changes.

interface SeasonalPricingRow {
  season: SeasonName;
  room_type: "fan" | "ac" | "premium"; // 3 price tiers only — premium applies to both premium_fan and premium_ac
  per_night_price: number;
  package_3_day: number;
  package_5_day: number;
  package_7_day: number;
  extra_bed_price: number;
}

export async function refreshSeasonalPricingFromApi(): Promise<void> {
  try {
    const res = await fetch("/api/seasonal-pricing");
    if (!res.ok) return;
    const rows: SeasonalPricingRow[] = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return;

    for (const row of rows) {
      const season = SEASONS.find((s) => s.name === row.season);
      if (!season) continue;

      const targetKeys: RoomKey[] = row.room_type === "premium" ? ["premium_fan", "premium_ac"] : [row.room_type];
      for (const key of targetKeys) {
        if (!season.rooms[key]) continue; // season doesn't offer this room type — skip
        season.perNight[key] = row.per_night_price;
        season.packagePrices[key] = {
          3: row.package_3_day || undefined,
          5: row.package_5_day || undefined,
          7: row.package_7_day || undefined,
        };
      }
      season.extraBedPerNight = row.extra_bed_price;
    }
  } catch {
    // API unavailable — hardcoded defaults remain active
  }
}
