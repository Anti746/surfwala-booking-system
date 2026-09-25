import { NextResponse } from "next/server";
import { ROOM_INVENTORY } from "@/lib/room-inventory";
import { getAvailableRooms } from "@/lib/mock-store";

const hasSupabase = !!(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const DAILY_CAPACITY = 20;
const ALL_ROOM_TYPES = Object.keys(ROOM_INVENTORY); // ["fan","ac","premium_fan","premium_ac"]

function normalizeRoomType(value: unknown): string {
  const type = String(value ?? "").toLowerCase();
  if (type === "standard" || type === "fan") return "fan";
  if (type === "superior" || type === "ac") return "ac";
  if (type === "premium") return "premium_ac";
  if (type === "premium_fan" || type === "premium_ac") return type;
  return type;
}

// Helper: build an array of { room, available: true } entries for freeCount rooms of type rt
function roomEntries(rt: string, freeCount: number) {
  return Array.from({ length: freeCount }, (_, i) => ({
    room: {
      id: `${rt}-${i + 1}`,
      name: `${rt.charAt(0).toUpperCase() + rt.slice(1)} Room ${i + 1}`,
      accommodation_type: { type: rt },
    },
    available: true as const,
  }));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");
  const type = searchParams.get("type");
  const filterType = searchParams.get("accommodation_type");
  const checkIn = searchParams.get("check_in") ?? date;
  const checkOut = searchParams.get("check_out") ?? (date
    ? (() => {
        const d = new Date(date + "T00:00:00");
        d.setDate(d.getDate() + 1);
        // Local-component formatting avoids the toISOString UTC-shift bug
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      })()
    : null);

  if (!date && !(type === "room" && checkIn && checkOut)) {
    return NextResponse.json({ error: "date is required" }, { status: 400 });
  }

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (hasSupabase) {
    try {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();

      if (type === "room") {
        const typesToCheck = filterType ? [normalizeRoomType(filterType)] : ALL_ROOM_TYPES;

        // Single overlap query for ALL types at once
        const { data: overlapping, error: overlapError } = await supabase
          .from("reservations")
          .select("accommodation_type")
          .neq("status", "cancelled")
          .not("check_in", "is", null)
          .not("check_out", "is", null)
          .lt("check_in", checkOut!)
          .gt("check_out", checkIn!);

        if (overlapError) {
          console.error("[v0] Availability query failed:", overlapError);
          return NextResponse.json({ error: "Availability could not be verified" }, { status: 503 });
        }

        const booked: Record<string, number> = {};
        for (const r of overlapping ?? []) {
          const t = normalizeRoomType(r.accommodation_type);
          if (ROOM_INVENTORY[t] !== undefined) booked[t] = (booked[t] ?? 0) + 1;
        }

        const result = typesToCheck.flatMap((rt) => {
          const free = Math.max(0, (ROOM_INVENTORY[rt] ?? 0) - (booked[rt] ?? 0));
          return roomEntries(rt, free);
        });

        return NextResponse.json(result);
      }

      // Surf capacity — count all reservations with a course_date (incl. Surf+Stay where course_id may be null)
      const { data: reservations, error: surfAvailabilityError } = await supabase
        .from("reservations")
        .select("number_of_people, course_date, course_time")
        .neq("status", "cancelled")
        .not("course_date", "is", null)
        .eq("course_date", date!);

      if (surfAvailabilityError) {
        console.error("[v0] Surf availability query failed:", surfAvailabilityError);
        return NextResponse.json({ error: "Availability could not be verified" }, { status: 503 });
      }

      const bySlot: Record<string, number> = { "08:00": 0, "10:00": 0 };
      for (const r of reservations ?? []) {
        const slot = r.course_time === "10:00" ? "10:00" : "08:00";
        bySlot[slot] += r.number_of_people || 1;
      }
      const remaining = { "08:00": Math.max(0, DAILY_CAPACITY - bySlot["08:00"]), "10:00": Math.max(0, DAILY_CAPACITY - bySlot["10:00"]) };
      const total = remaining["08:00"] + remaining["10:00"];
      return NextResponse.json({ available: total > 0, remainingCapacity: total, slots: remaining });

    } catch (err) {
      console.error("[v0] Supabase error in availability:", err);
      return NextResponse.json({ error: "Availability could not be verified" }, { status: 503 });
    }
  }

  // ── Mock fallback ──────────────────────────────────────────────────────────
  if (type === "room") {
    const typesToCheck = filterType ? [filterType] : ALL_ROOM_TYPES;
    const result = typesToCheck.flatMap((rt) =>
      roomEntries(rt, getAvailableRooms(rt, checkIn!, checkOut!))
    );
    return NextResponse.json(result);
  }

  // Mock surf capacity — count all reservations with a course_date, same as
  // the Supabase path above (Surf+Stay bookings may have course_id === null).
  const { mockReservations } = await import("@/lib/mock-store");
  const bySlot: Record<string, number> = { "08:00": 0, "10:00": 0 };
  for (const r of mockReservations.filter((r) => r.status !== "cancelled" && r.course_date === date)) {
    const slot = (r as any).course_time === "10:00" ? "10:00" : "08:00";
    bySlot[slot] += r.number_of_people || 1;
  }
  const remaining = { "08:00": Math.max(0, DAILY_CAPACITY - bySlot["08:00"]), "10:00": Math.max(0, DAILY_CAPACITY - bySlot["10:00"]) };
  const total = remaining["08:00"] + remaining["10:00"];
  return NextResponse.json({ available: total > 0, remainingCapacity: total, slots: remaining });
}
