import { NextRequest, NextResponse } from "next/server";

const hasSupabase = !!(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Only 3 price tiers are stored/edited: premium_fan and premium_ac ALWAYS
// share the same price, so there is exactly one "premium" row per season —
// editing it updates both room types (see lib/pricing.ts refreshSeasonalPricingFromApi).
export interface SeasonalPricingRow {
  id: string;
  season: "peaceful" | "loafer" | "busy" | "blackout";
  room_type: "fan" | "ac" | "premium";
  per_night_price: number;
  package_3_day: number;
  package_5_day: number;
  package_7_day: number;
  extra_bed_price: number;
}

// Hardcoded fallback — mirrors lib/pricing.ts defaults, used only when
// Supabase isn't configured or the table is empty/not yet migrated.
const FALLBACK_PRICING: SeasonalPricingRow[] = [
  { id: "peaceful-fan",     season: "peaceful", room_type: "fan",     per_night_price: 3000, package_3_day: 15300, package_5_day: 22950, package_7_day: 29500, extra_bed_price: 1000 },
  { id: "peaceful-ac",      season: "peaceful", room_type: "ac",      per_night_price: 4000, package_3_day: 18000, package_5_day: 27200, package_7_day: 35000, extra_bed_price: 1000 },
  { id: "peaceful-premium", season: "peaceful", room_type: "premium", per_night_price: 5000, package_3_day: 20700, package_5_day: 31450, package_7_day: 40000, extra_bed_price: 1000 },

  { id: "loafer-ac",      season: "loafer", room_type: "ac",      per_night_price: 2000, package_3_day: 15000, package_5_day: 22200, package_7_day: 30000, extra_bed_price: 1000 },
  { id: "loafer-premium", season: "loafer", room_type: "premium", per_night_price: 3000, package_3_day: 17700, package_5_day: 26450, package_7_day: 35000, extra_bed_price: 1000 },

  { id: "busy-fan",     season: "busy", room_type: "fan",     per_night_price: 4000, package_3_day: 18000, package_5_day: 27200, package_7_day: 35200, extra_bed_price: 1000 },
  { id: "busy-ac",      season: "busy", room_type: "ac",      per_night_price: 5000, package_3_day: 20700, package_5_day: 31450, package_7_day: 40800, extra_bed_price: 1000 },
  { id: "busy-premium", season: "busy", room_type: "premium", per_night_price: 6000, package_3_day: 23400, package_5_day: 35700, package_7_day: 46400, extra_bed_price: 1000 },

  { id: "blackout-fan",     season: "blackout", room_type: "fan",     per_night_price: 5000, package_3_day: 0, package_5_day: 0, package_7_day: 0, extra_bed_price: 0 },
  { id: "blackout-ac",      season: "blackout", room_type: "ac",      per_night_price: 6000, package_3_day: 0, package_5_day: 0, package_7_day: 0, extra_bed_price: 0 },
  { id: "blackout-premium", season: "blackout", room_type: "premium", per_night_price: 7000, package_3_day: 0, package_5_day: 0, package_7_day: 0, extra_bed_price: 0 },
];

// In-memory mutable copy used when Supabase isn't configured, so dashboard
// edits still persist for the lifetime of the server process.
const mockPricing: SeasonalPricingRow[] = FALLBACK_PRICING.map((r) => ({ ...r }));

// ── GET — list all seasonal pricing rows ────────────────────────────────────
export async function GET() {
  try {
    if (hasSupabase) {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();

      const { data, error } = await supabase
        .from("seasonal_pricing")
        .select("*")
        .order("season", { ascending: true })
        .order("room_type", { ascending: true });

      if (error) {
        console.error("SEASONAL PRICING FETCH ERROR:", error);
        return NextResponse.json(FALLBACK_PRICING);
      }

      if (!data || data.length === 0) {
        return NextResponse.json(FALLBACK_PRICING);
      }

      // Safety net: if the DB table still has old-style separate premium_fan/
      // premium_ac rows (pre-consolidation), collapse them to a single
      // "premium" row so the dashboard/chatbot see the new 3-tier shape.
      const hasOldSplitRows = data.some((r: any) => r.room_type === "premium_fan" || r.room_type === "premium_ac");
      if (hasOldSplitRows) {
        console.error("SEASONAL PRICING: DB table still has premium_fan/premium_ac split rows — using fallback until migrated");
        return NextResponse.json(FALLBACK_PRICING);
      }

      return NextResponse.json(data);
    }

    return NextResponse.json(mockPricing);
  } catch (err) {
    console.error("SERVER ERROR (GET seasonal-pricing):", err);
    return NextResponse.json(FALLBACK_PRICING);
  }
}

// ── PUT — update a single (season, room_type) row ───────────────────────────
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { season, room_type, per_night_price, package_3_day, package_5_day, package_7_day, extra_bed_price } = body;

    if (!season || !room_type) {
      return NextResponse.json({ error: "season and room_type are required" }, { status: 400 });
    }

    const updates: Record<string, number> = {};
    if (typeof per_night_price === "number") updates.per_night_price = per_night_price;
    if (typeof package_3_day === "number") updates.package_3_day = package_3_day;
    if (typeof package_5_day === "number") updates.package_5_day = package_5_day;
    if (typeof package_7_day === "number") updates.package_7_day = package_7_day;
    if (typeof extra_bed_price === "number") updates.extra_bed_price = extra_bed_price;

    if (hasSupabase) {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();

      const { data, error } = await supabase
        .from("seasonal_pricing")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("season", season)
        .eq("room_type", room_type)
        .select()
        .single();

      if (error) {
        console.error("SEASONAL PRICING UPDATE ERROR:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json(data);
    }

    // Mock fallback
    const row = mockPricing.find((r) => r.season === season && r.room_type === room_type);
    if (!row) {
      return NextResponse.json({ error: "Row not found" }, { status: 404 });
    }
    Object.assign(row, updates);
    return NextResponse.json(row);
  } catch (err) {
    console.error("SERVER ERROR (PUT seasonal-pricing):", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
