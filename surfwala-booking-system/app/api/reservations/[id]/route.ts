import { NextResponse } from "next/server";

// ── shared mock store (same instance as /api/reservations/route.ts) ──────────
// Because Next.js bundles each route separately, we keep the store in a module
// that both routes import so they share the same in-memory array.
import { hasSupabase, mockReservations } from "@/lib/mock-store";
import { ROOM_INVENTORY } from "@/lib/room-inventory";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (hasSupabase) {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("reservations")
      .select(`*, customer:customers(*), course:courses(*), instructor:instructors(*), room:rooms(*, accommodation_type:accommodation_types(*))`)
      .eq("id", id)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json(data);
  }

  const reservation = mockReservations.find((r) => r.id === id);
  if (!reservation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(reservation);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.status !== undefined) updateData.status = body.status;
  if (body.instructor_id !== undefined) updateData.instructor_id = body.instructor_id;
  if (body.room_id !== undefined) updateData.room_id = body.room_id;
  if (body.special_requests !== undefined) updateData.special_requests = body.special_requests;
  if (body.total_price !== undefined) updateData.total_price = body.total_price;
  if (body.google_calendar_event_id !== undefined)
    updateData.google_calendar_event_id = body.google_calendar_event_id;
  // ── Admin-editable booking fields ─────────────────────────────────────────
  if (body.check_in !== undefined) updateData.check_in = body.check_in;
  if (body.check_out !== undefined) updateData.check_out = body.check_out;
  if (body.accommodation_type !== undefined) updateData.accommodation_type = body.accommodation_type;
  if (body.course_date !== undefined) updateData.course_date = body.course_date;
  if (body.course_time !== undefined) updateData.course_time = body.course_time;
  if (body.surf_end_date !== undefined) updateData.surf_end_date = body.surf_end_date;
  if (body.number_of_people !== undefined) updateData.number_of_people = body.number_of_people;

  // ── Try Supabase first (only if configured) ──────────────────────────────
  if (hasSupabase) {
    try {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();

      // ── Availability validation on accommodation changes ─────────────────
      // If the admin changes dates or room type, verify the NEW combination is
      // available — counting overlaps but EXCLUDING this reservation itself
      // (otherwise the reservation would block its own edit).
      const changesAccommodation =
        body.check_in !== undefined || body.check_out !== undefined || body.accommodation_type !== undefined;

      if (changesAccommodation) {
        // Fetch current values to merge with the incoming partial update
        const { data: existing } = await supabase
          .from("reservations")
          .select("check_in, check_out, accommodation_type")
          .eq("id", id)
          .single();

        const newCheckIn = body.check_in ?? existing?.check_in;
        const newCheckOut = body.check_out ?? existing?.check_out;
        const newType = body.accommodation_type ?? existing?.accommodation_type;

        // Only validate if this is an accommodation reservation with full data
        if (newCheckIn && newCheckOut && newType) {
          if (newCheckIn >= newCheckOut) {
            return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
          }
          const { data: overlapping, error: overlapErr } = await supabase
            .from("reservations")
            .select("id")
            .eq("accommodation_type", newType)
            .neq("status", "cancelled")
            .neq("id", id) // exclude this reservation from blocking itself
            .not("check_in", "is", null)
            .not("check_out", "is", null)
            .lt("check_in", newCheckOut)
            .gt("check_out", newCheckIn);

          if (overlapErr) {
            return NextResponse.json({ error: overlapErr.message }, { status: 500 });
          }
          const booked = overlapping?.length ?? 0;
          const total = ROOM_INVENTORY[newType] ?? 0;
          if (booked >= total) {
            return NextResponse.json(
              { error: `No ${newType} rooms available for the new dates (${booked}/${total} booked). Change rejected.` },
              { status: 409 }
            );
          }
        }
      }

      const { data, error } = await supabase
        .from("reservations")
        .update(updateData)
        .eq("id", id)
        .select(`*, customer:customers(*), course:courses(*), instructor:instructors(*), room:rooms(*, accommodation_type:accommodation_types(*))`)
        .single();

      if (error) throw error;

      if (body.status === "confirmed") await sendConfirmationEmail(data);
      return NextResponse.json(data);
    } catch (err) {
      // Supabase failed → fall through to the in-memory mock store
    }
  }

  // ── Mock fallback (no Supabase, or Supabase failed) ──────────────────────
  const reservation = mockReservations.find((r) => r.id === id);
  if (!reservation) {
    return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
  }

  // Same availability validation for the mock store (excluding self)
  const changesAccommodationMock =
    body.check_in !== undefined || body.check_out !== undefined || body.accommodation_type !== undefined;
  if (changesAccommodationMock) {
    const newCheckIn = body.check_in ?? reservation.check_in;
    const newCheckOut = body.check_out ?? reservation.check_out;
    const newType = body.accommodation_type ?? reservation.accommodation_type;
    if (newCheckIn && newCheckOut && newType) {
      if (newCheckIn >= newCheckOut) {
        return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
      }
      const bookedExcludingSelf = mockReservations.filter(
        (r) =>
          r.id !== id &&
          r.status !== "cancelled" &&
          r.accommodation_type === newType &&
          r.check_in && r.check_out &&
          r.check_in < newCheckOut && r.check_out > newCheckIn
      ).length;
      const total = ROOM_INVENTORY[newType] ?? 0;
      if (bookedExcludingSelf >= total) {
        return NextResponse.json(
          { error: `No ${newType} rooms available for the new dates (${bookedExcludingSelf}/${total} booked). Change rejected.` },
          { status: 409 }
        );
      }
    }
  }

  Object.assign(reservation, updateData);
  if (body.status === "confirmed") await sendConfirmationEmail(reservation);
  return NextResponse.json(reservation);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (hasSupabase) {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { error } = await supabase.from("reservations").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  const index = mockReservations.findIndex((r) => r.id === id);
  if (index === -1) return NextResponse.json({ error: "Not found" }, { status: 404 });
  mockReservations.splice(index, 1);
  return NextResponse.json({ success: true });
}

async function sendConfirmationEmail(reservation: any) {
  const toEmail = reservation?.customer?.email;
  const apiKey = process.env.RESEND_API_KEY;
  if (!toEmail || !apiKey) return;

  const firstName = reservation?.customer?.first_name || "there";
  const people = reservation?.number_of_people ?? 1;

  let detailsText: string;
  if (reservation?.course_date) {
    const courseName = reservation?.course?.name || "your surf course";
    detailsText = `Course: ${courseName}\nDate: ${reservation.course_date}`;
  } else if (reservation?.check_in && reservation?.check_out) {
    const roomType = reservation?.accommodation_type ?? "room";
    detailsText = `Room: ${roomType}\nCheck-in: ${reservation.check_in}\nCheck-out: ${reservation.check_out}`;
  } else {
    detailsText = "Booking details on file.";
  }

  const text = `Hello ${firstName},\n\nYour booking has been confirmed.\n\n${detailsText}\nPeople: ${people}\n\nThank you!`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "Surf Wala <onboarding@resend.dev>",
        to: toEmail,
        subject: "Booking Confirmed",
        text,
      }),
    });
  } catch (err) {
    console.error("Failed to send confirmation email:", err);
  }
}
