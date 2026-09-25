import { NextResponse } from "next/server";
import { courses } from "@/lib/mock-data";
import {
  hasSupabase, mockReservations, mockCustomers, generateId, getAvailableRooms,
} from "@/lib/mock-store";
import { ROOM_INVENTORY } from "@/lib/room-inventory";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function normalizeRoomType(value: unknown): string {
  const type = String(value ?? "").toLowerCase();
  if (type === "standard" || type === "fan") return "fan";
  if (type === "superior" || type === "ac") return "ac";
  if (type === "premium") return "premium_ac";
  if (type === "premium_fan" || type === "premium_ac") return type;
  return type;
}

// Course type → number of surf days (used to compute surf_end_date in both paths)
function courseDays(courseName?: string, courseType?: string): number {
  if (courseName?.includes("7 Day") || courseType === "week") return 7;
  if (courseName?.includes("5 Day") || courseType === "immerse") return 5;
  if (courseName?.includes("3 Day") || courseType === "plunge") return 3;
  return 1;
}

function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days - 1);
  // Local-component formatting avoids the toISOString UTC-shift bug — important
  // here because this runs server-side, and if the server's timezone isn't UTC
  // (e.g. deployed with TZ=Asia/Kolkata for this India-based business),
  // toISOString() would silently shift the date by a day.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Build neededByType map: { fan: 2, premium: 1 } etc from body.accommodation_type + body.extra_room_types
function buildNeededByType(body: any): Record<string, number> {
  const n: Record<string, number> = {};
  const rooms = body.rooms_needed ?? 1;
  for (let i = 0; i < rooms; i++) {
    const rawType = i === 0 ? body.accommodation_type : (body.extra_room_types?.[i - 1] ?? body.accommodation_type);
    const rt = normalizeRoomType(rawType);
    if (rt) n[rt] = (n[rt] ?? 0) + 1;
  }
  return n;
}

// ── GET – list reservations ───────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    if (hasSupabase) {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();
      const { searchParams } = new URL(request.url);
      const status = searchParams.get("status");
      const date = searchParams.get("date");

      let query = supabase
        .from("reservations")
        .select(`*, customer:customers(*), course:courses(*), instructor:instructors(*), room:rooms(*, accommodation_type:accommodation_types(*))`)
        .order("created_at", { ascending: false });

      if (status) query = query.eq("status", status);
      if (date) query = query.or(`course_date.eq.${date},check_in.eq.${date}`);

      const { data, error } = await query;
      if (error) {
        console.error("GET RESERVATIONS ERROR:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const enriched = (data ?? []).map((r: any) => {
        if (!r.course_date) return { ...r, surf_end_date: null };
        const days = courseDays(r.course?.name, r.course?.type);
        const surf_end_date = days > 1 ? addDaysToDate(r.course_date, days) : r.course_date;
        return { ...r, surf_end_date };
      });

      return NextResponse.json(enriched);
    }

    return NextResponse.json(mockReservations);
  } catch (err) {
    console.error("SERVER ERROR (GET):", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// ── POST – create reservation(s) ─────────────────────────────────────────────
// Accommodation types use the unified "fan/ac/premium" convention throughout.
// For serviceType="both", creates TWO records: one surf, one accommodation.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.customer) {
      return NextResponse.json({ error: "Customer information is required" }, { status: 400 });
    }

    const wantsSurf = !!(body.course_type || body.course_id || body.course_date);
    const wantsStay = !!(body.accommodation_type || body.check_in || body.check_out);

    // ── Supabase path ─────────────────────────────────────────────────────────
    if (hasSupabase) {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();

      // ── Validate accommodation availability (real DB, per room type) ────────
      if (wantsStay && body.check_in && body.check_out && body.accommodation_type) {
        const neededByType = buildNeededByType(body);

        // Single query for ALL types that overlap the requested period
        const { data: overlapping, error: overlapErr } = await supabase
          .from("reservations")
          .select("accommodation_type")
          .neq("status", "cancelled")
          .not("check_in", "is", null)
          .not("check_out", "is", null)
          .lt("check_in", body.check_out)
          .gt("check_out", body.check_in);

        if (overlapErr) {
          console.error("AVAILABILITY CHECK ERROR:", overlapErr);
          return NextResponse.json({ error: overlapErr.message }, { status: 500 });
        }

        const booked: Record<string, number> = {};
        for (const r of overlapping ?? []) {
          const t = normalizeRoomType(r.accommodation_type);
          if (ROOM_INVENTORY[t] !== undefined) booked[t] = (booked[t] ?? 0) + 1;
        }

        for (const [roomType, needed] of Object.entries(neededByType)) {
          const available = Math.max(0, (ROOM_INVENTORY[roomType] ?? 0) - (booked[roomType] ?? 0));
          if (available < needed) {
            return NextResponse.json(
              { error: `Not enough ${roomType} rooms available for this period. Needed: ${needed}, Available: ${available}` },
              { status: 409 }
            );
          }
        }
      }

      // ── Resolve course ──────────────────────────────────────────────────────
      let resolvedCourseId: string | null = null;
      if (wantsSurf) {
        if (body.course_id && isUuid(body.course_id)) {
          resolvedCourseId = body.course_id;
        } else {
          const key = body.course_type || (body.course_id && !isUuid(body.course_id) ? body.course_id : null);
          if (key) {
            const { data: c } = await supabase.from("courses").select("id").or(`type.eq.${key},name.ilike.%${key}%`).limit(1).maybeSingle();
            resolvedCourseId = c?.id ?? null;
          }
        }
      }

      // ── Upsert customer ─────────────────────────────────────────────────────
      let customerId: string;
      const { data: existingCustomer } = await supabase
        .from("customers").select("id").eq("email", body.customer.email).maybeSingle();

      if (existingCustomer) {
        customerId = existingCustomer.id;
      } else {
        const { data: newCustomer, error: customerError } = await supabase
          .from("customers")
          .insert({ first_name: body.customer.first_name, last_name: body.customer.last_name, email: body.customer.email, phone: body.customer.phone, instagram_id: body.customer.instagram_id })
          .select("id").single();
        if (customerError) {
          console.error("CUSTOMER ERROR:", customerError);
          return NextResponse.json({ error: customerError.message }, { status: 500 });
        }
        customerId = newCustomer.id;
      }

      const results: any[] = [];

      // ── Surf reservation ────────────────────────────────────────────────────
      if (wantsSurf) {
        const surfPrice = typeof body.surf_total_price === "number" ? body.surf_total_price : 0;
        const courseForDuration = resolvedCourseId
          ? (await supabase.from("courses").select("name, type").eq("id", resolvedCourseId).single()).data
          : null;
        // Fall back to body.course_type so packages (week/immerse/plunge) always get the right duration
        // even when course_id lookup fails (e.g. course not yet seeded in DB).
        const days = courseDays(courseForDuration?.name, courseForDuration?.type ?? body.course_type);
        const surf_end_date = body.course_date && days > 1 ? addDaysToDate(body.course_date, days) : (body.course_date ?? null);

        const { data: surfRes, error: surfErr } = await supabase
          .from("reservations")
          .insert({
            customer_id: customerId, course_id: resolvedCourseId,
            course_date: body.course_date || null, course_time: body.course_time || null,
            surf_end_date: surf_end_date,
            number_of_people: body.number_of_people || 1, number_of_non_swimmers: body.number_of_non_swimmers || 0,
            accommodation_type: null, check_in: null, check_out: null,
            special_requests: body.special_requests || null,
            total_price: surfPrice, status: "pending",
          })
          .select(`*, customer:customers(*), course:courses(*)`).single();

        if (surfErr) {
          console.error("SURF RESERVATION ERROR:", surfErr);
          return NextResponse.json({ error: surfErr.message }, { status: 500 });
        }
        results.push({ ...surfRes, surf_end_date, type: "surf" });
      }

      // ── Accommodation reservation(s) ────────────────────────────────────────
      if (wantsStay && body.check_in && body.check_out) {
        const roomsNeeded: number = body.rooms_needed ?? 1;
        const accTotal: number = typeof body.accommodation_total_price === "number" ? body.accommodation_total_price : 0;
        const perRoom = Math.floor(accTotal / roomsNeeded);

        for (let i = 0; i < roomsNeeded; i++) {
          const roomType = normalizeRoomType(i === 0 ? body.accommodation_type : (body.extra_room_types?.[i - 1] ?? body.accommodation_type));
          const roomPrice = perRoom + (i === roomsNeeded - 1 ? accTotal - perRoom * roomsNeeded : 0);

          const { data: accRes, error: accErr } = await supabase
            .from("reservations")
            .insert({
              customer_id: customerId, course_id: null, course_date: null, course_time: null,
              number_of_people: body.accommodation_people ?? body.number_of_people ?? 1, number_of_non_swimmers: 0,
              accommodation_type: roomType, check_in: body.check_in, check_out: body.check_out,
              special_requests: body.special_requests || null,
              total_price: roomPrice, status: "pending",
            })
            .select(`*, customer:customers(*)`).single();

          if (accErr) {
            console.error("ACCOMMODATION RESERVATION ERROR:", accErr);
            return NextResponse.json({ error: accErr.message }, { status: 500 });
          }
          results.push({ ...accRes, type: "accommodation" });
        }
      }

      const primary = results[0] ?? {};
      return NextResponse.json({ ...primary, linked: results.slice(1) }, { status: 201 });
    }

    // ── Mock fallback ─────────────────────────────────────────────────────────

    // Validate availability against mock store
    if (wantsStay && body.check_in && body.check_out && body.accommodation_type) {
      for (const [roomType, needed] of Object.entries(buildNeededByType(body))) {
        const available = getAvailableRooms(roomType, body.check_in, body.check_out);
        if (available < needed) {
          return NextResponse.json(
            { error: `Not enough ${roomType} rooms available for this period. Needed: ${needed}, Available: ${available}` },
            { status: 409 }
          );
        }
      }
    }

    // Upsert mock customer
    const email = body.customer.email || null;
    let existing = email ? mockCustomers.find((c) => c.email === email) : undefined;
    if (existing) {
      existing.first_name = body.customer.first_name ?? existing.first_name;
      existing.last_name = body.customer.last_name ?? existing.last_name;
      existing.phone = body.customer.phone ?? existing.phone;
    } else {
      existing = { id: generateId(), first_name: body.customer.first_name || "", last_name: body.customer.last_name || "", email, phone: body.customer.phone || null, instagram_id: body.customer.instagram_id || null, created_at: new Date().toISOString() };
      mockCustomers.push(existing);
    }
    const customerId = existing.id;

    const course = wantsSurf
      ? courses.find((c) => c.id === (body.course_id ?? "") || c.type === (body.course_type ?? "") || c.name.toLowerCase().includes(String(body.course_type ?? "").toLowerCase())) ?? null
      : null;

    const created: any[] = [];

    if (wantsSurf) {
      const days = courseDays(course?.name, course?.type);
      const surf_end_date = body.course_date && days > 1 ? addDaysToDate(body.course_date, days) : (body.course_date ?? null);
      const surfRes = {
        id: generateId(), customer_id: customerId,
        customer: { id: customerId, ...body.customer },
        course_id: course?.id ?? null, course,
        course_date: body.course_date || null, surf_end_date,
        course_time: body.course_time || null,
        accommodation_type: null, room_id: null, check_in: null, check_out: null,
        number_of_people: body.number_of_people || 1, number_of_non_swimmers: body.number_of_non_swimmers || 0,
        special_requests: body.special_requests || null,
        total_price: typeof body.surf_total_price === "number" ? body.surf_total_price : (course ? course.price * (body.number_of_people || 1) : 0),
        status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      mockReservations.push(surfRes);
      created.push({ ...surfRes, type: "surf" });
    }

    if (wantsStay && body.check_in && body.check_out) {
      const roomsNeeded: number = body.rooms_needed ?? 1;
      const accTotal: number = typeof body.accommodation_total_price === "number" ? body.accommodation_total_price : 0;
      const perRoom = Math.floor(accTotal / roomsNeeded);

      for (let i = 0; i < roomsNeeded; i++) {
        const roomType = i === 0 ? (body.accommodation_type || null) : (body.extra_room_types?.[i - 1] ?? body.accommodation_type ?? null);
        const accRes = {
          id: generateId(), customer_id: customerId,
          customer: { id: customerId, ...body.customer },
          course_id: null, course: null, course_date: null, surf_end_date: null, course_time: null,
          accommodation_type: roomType, room_id: roomType ? `${roomType}-${i + 1}` : null,
          check_in: body.check_in, check_out: body.check_out,
          number_of_people: body.accommodation_people ?? body.number_of_people ?? 1, number_of_non_swimmers: 0,
          special_requests: body.special_requests || null,
          total_price: perRoom + (i === roomsNeeded - 1 ? accTotal - perRoom * roomsNeeded : 0),
          status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        mockReservations.push(accRes);
        created.push({ ...accRes, type: "accommodation" });
      }
    }

    if (created.length === 0) {
      return NextResponse.json({ error: "No valid booking data provided" }, { status: 400 });
    }

    return NextResponse.json({ ...created[0], linked: created.slice(1) }, { status: 201 });
  } catch (err) {
    console.error("SERVER ERROR (POST):", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
