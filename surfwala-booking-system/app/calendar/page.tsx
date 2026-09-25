"use client";

import { useState } from "react";
import useSWR from "swr";
import { format, startOfWeek, addDays, isSameDay } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, X, DoorOpen } from "lucide-react";
import type { Reservation } from "@/lib/types";
import { ROOM_INVENTORY } from "@/lib/room-inventory";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json();
  if (data?.error || !Array.isArray(data)) return [];
  return data;
};

// ── Deterministic color from customer name ────────────────────────────────────
const CUSTOMER_COLORS = [
  "bg-blue-100 text-blue-800 border-l-blue-500",
  "bg-purple-100 text-purple-800 border-l-purple-500",
  "bg-emerald-100 text-emerald-800 border-l-emerald-500",
  "bg-orange-100 text-orange-800 border-l-orange-500",
  "bg-rose-100 text-rose-800 border-l-rose-500",
  "bg-teal-100 text-teal-800 border-l-teal-500",
  "bg-yellow-100 text-yellow-800 border-l-yellow-500",
  "bg-indigo-100 text-indigo-800 border-l-indigo-500",
  "bg-pink-100 text-pink-800 border-l-pink-500",
  "bg-cyan-100 text-cyan-800 border-l-cyan-500",
];

function customerColor(r: Reservation): string {
  const key = `${r.customer?.first_name ?? ""}${r.customer?.last_name ?? ""}${r.customer_id ?? ""}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return CUSTOMER_COLORS[hash % CUSTOMER_COLORS.length];
}

// Surf+Stay package bookings store a "PACKAGE: N Day/N Night - ..." marker in
// special_requests (set by the chatbot). Use it to label the accommodation
// row with the package context instead of just the bare room type.
const packageLabel = (r: Reservation): string | null => {
  if (!r.special_requests) return null;
  const match = r.special_requests.match(/PACKAGE:\s*(\d+)\s*Day\/\1\s*Night/);
  return match ? `Surf + Stay — ${match[1]} Day Course` : null;
};

// Best-effort label for a reservation's surf course: prefer the joined course
// row; if it didn't resolve (e.g. course_id is null), fall back to duration
// inferred from surf_end_date, or a generic label.
const courseLabel = (r: Reservation): string => {
  if (r.course?.name) return r.course.name;
  if (r.course_date && r.surf_end_date && r.surf_end_date !== r.course_date) {
    const start = new Date(r.course_date + "T00:00:00");
    const end = new Date(r.surf_end_date + "T00:00:00");
    const days = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return `${days} Day Course`;
  }
  return "Surf Lesson";
};

// ── Helpers ───────────────────────────────────────────────────────────────────
// A surf reservation is identified by having a course_date set, NOT solely by
// course_id — the course lookup can fail to resolve (e.g. a course type not yet
// seeded in the DB), but the reservation should still show up in the calendar.
const isSurfReservation = (r: Reservation) => !!r.course_date;

const getBookingType = (r: Reservation) => {
  const hasCourse = isSurfReservation(r);
  const hasRoom = !!r.room_id || !!r.accommodation_type;
  if (hasCourse && hasRoom) return "Surf + Stay";
  if (hasCourse) return "Surf";
  if (hasRoom) return "Accommodation";
  return "Unknown";
};

interface DayModalProps {
  date: Date;
  reservations: Reservation[];
  onClose: () => void;
}

function DayModal({ date, reservations, onClose }: DayModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold text-foreground">
            {format(date, "EEEE, MMMM d")}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-2">
          {reservations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No reservations</p>
          ) : (
            reservations.map((r) => (
              <div
                key={r.id}
                className={`rounded-lg border-l-2 p-3 text-sm ${customerColor(r)}`}
              >
                <div className="font-semibold">
                  {r.customer?.first_name} {r.customer?.last_name}
                </div>
                <div className="mt-0.5 text-xs opacity-80">
                  {getBookingType(r)}
                  {r.course_time ? ` · ${r.course_time}` : ""}
                  {/* FIX 5: show people count */}
                  {r.number_of_people ? ` · ${r.number_of_people} people` : ""}
                </div>
                <div className="mt-0.5 text-xs opacity-70">
                  {r.course?.name || (r.accommodation_type ? `${r.accommodation_type} room` : "")}
                  {/* FIX 6: show non-swimmer split in modal */}
                  {(r.number_of_non_swimmers ?? 0) > 0 && r.number_of_people && (
                    <span className="ml-1 text-rose-600">
                      ({r.number_of_people - r.number_of_non_swimmers!} group + {r.number_of_non_swimmers} private)
                    </span>
                  )}
                </div>
                <Badge
                  variant="secondary"
                  className="mt-1 text-[10px] px-1.5 py-0 capitalize"
                >
                  {r.status}
                </Badge>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const ROOM_TYPE_LABELS: Record<string, string> = {
  fan:         "Fan Room",
  ac:          "AC Room",
  premium_fan: "Premium Fan Room",
  premium_ac:  "Premium AC Room",
};

// ── Room Occupation tab: shows, per room TYPE and per day, how many of that
// type are booked out of the total inventory for that type. ──────────────────
function RoomOccupationView({
  reservations,
  weekStart,
  weekDays,
}: {
  reservations: Reservation[];
  weekStart: Date;
  weekDays: Date[];
}) {
  const roomTypes = Object.keys(ROOM_INVENTORY);

  const isAccActiveOnDay = (r: Reservation, date: Date, dateStr: string): boolean => {
    if (!r.check_in || !r.check_out) return false;
    const ci = new Date(r.check_in + "T00:00:00");
    const co = new Date(r.check_out + "T00:00:00");
    return ci <= date && date < co;
  };

  const getBookedCountForType = (roomType: string, day: Date): number => {
    const dateStr = format(day, "yyyy-MM-dd");
    return reservations.filter(
      (r) =>
        r.accommodation_type === roomType &&
        r.status !== "cancelled" &&
        isAccActiveOnDay(r, day, dateStr)
    ).length;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base md:text-lg">
          {format(weekStart, "MMMM d")} – {format(addDays(weekStart, 6), "MMMM d, yyyy")}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <div className="grid grid-cols-8 min-w-[640px]">
            {/* Header row */}
            <div className="p-2 border-b border-r text-xs font-medium text-muted-foreground">Room Type</div>
            {weekDays.map((day) => (
              <div
                key={day.toISOString()}
                className={`p-2 border-b text-center ${isSameDay(day, new Date()) ? "bg-primary/10 font-bold" : ""}`}
              >
                <div className="text-xs text-muted-foreground">{format(day, "EEE")}</div>
                <div className="text-sm md:text-lg">{format(day, "d")}</div>
              </div>
            ))}

            {/* One row per room type */}
            {roomTypes.map((roomType) => {
              const total = ROOM_INVENTORY[roomType];
              return (
                <>
                  <div key={`label-${roomType}`} className="flex items-center gap-2 p-2 border-r border-b text-xs font-medium">
                    <DoorOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span>{ROOM_TYPE_LABELS[roomType] ?? roomType}</span>
                  </div>
                  {weekDays.map((day) => {
                    const booked = getBookedCountForType(roomType, day);
                    const isFull = booked >= total;
                    const isEmpty = booked === 0;
                    return (
                      <div
                        key={`${roomType}-${day.toISOString()}`}
                        className={`flex items-center justify-center border-b p-2 text-sm font-medium ${
                          isFull
                            ? "bg-destructive/10 text-destructive"
                            : isEmpty
                            ? "text-muted-foreground"
                            : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {booked}/{total}
                      </div>
                    );
                  })}
                </>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 p-3 text-xs text-muted-foreground border-t">
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-destructive/10" /> Fully booked</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-amber-50 border border-amber-200" /> Partially booked</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border" /> Empty</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CalendarPage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [modal, setModal] = useState<{ date: Date; reservations: Reservation[] } | null>(null);
  const [activeTab, setActiveTab] = useState<"reservations" | "occupation">("reservations");
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });

  const { data: rawReservations = [] } = useSWR<Reservation[]>("/api/reservations", fetcher);
  // Cancelled reservations disappear from the calendar entirely (both the
  // Reservations tab here and Room Occupation, which filters separately).
  const reservations = rawReservations.filter((r) => r.status !== "cancelled");

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // ── Course duration helpers ──────────────────────────────────────────────────
  const getSurfEndDate = (r: Reservation): string | null => {
    if (r.surf_end_date) return r.surf_end_date;
    if (!r.course_date) return null;
    const name = r.course?.name ?? "";
    const type = r.course?.type ?? "";
    let days = 1;
    if (name.includes("7 Day") || type === "week") days = 7;
    else if (name.includes("5 Day") || type === "immerse") days = 5;
    else if (name.includes("3 Day") || type === "plunge") days = 3;
    if (days <= 1) return r.course_date;
    const start = new Date(r.course_date + "T00:00:00");
    start.setDate(start.getDate() + days - 1);
    // Local-component formatting avoids the toISOString UTC-shift bug
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  };

  // Surf active on date: course_date <= date <= surf_end_date
  const isSurfActiveOnDay = (r: Reservation, dateStr: string): boolean => {
    if (!isSurfReservation(r)) return false;
    const end = getSurfEndDate(r) ?? r.course_date!;
    return r.course_date! <= dateStr && dateStr <= end;
  };

  // Accommodation active on date: check_in <= date < check_out (blocks check_in through day before check_out)
  const isAccActiveOnDay = (r: Reservation, date: Date, dateStr: string): boolean => {
    if (!r.check_in || !r.check_out) return false;
    const ci = new Date(r.check_in + "T00:00:00");
    const co = new Date(r.check_out + "T00:00:00");
    return ci <= date && date < co;
  };

  // Surf reservations: records with a course_date active on this day
  const getSurfReservationsForDay = (date: Date): Reservation[] => {
    const dateStr = format(date, "yyyy-MM-dd");
    return reservations.filter((r) => isSurfReservation(r) && isSurfActiveOnDay(r, dateStr));
  };

  // Accommodation reservations: records that have check_in/check_out (regardless of whether they also have a course)
  // This ensures Surf+Stay accommodation records appear in the Stay row.
  const getAccReservationsForDay = (date: Date): Reservation[] => {
    const dateStr = format(date, "yyyy-MM-dd");
    return reservations.filter(
      (r) => !isSurfReservation(r) && (r.room_id || r.accommodation_type) && isAccActiveOnDay(r, date, dateStr)
    );
  };

  const getReservationsForDay = (date: Date) => {
    const dateStr = format(date, "yyyy-MM-dd");
    return reservations.filter(
      (r) =>
        (isSurfReservation(r) && isSurfActiveOnDay(r, dateStr)) ||
        (!isSurfReservation(r) && (r.room_id || r.accommodation_type) && isAccActiveOnDay(r, date, dateStr))
    );
  };

  const MAX_VISIBLE = 3;
  const timeSlots = ["08:00", "10:00"];

  // FIX 5: show people count; FIX 6: split private/non-swimmers entries
  const ReservationCard = ({ r, overrideLabel, overrideCount }: {
    r: Reservation;
    overrideLabel?: string;
    overrideCount?: number;
  }) => {
    const displayName = `${r.customer?.first_name ?? ""} ${(r.customer?.last_name ?? "").charAt(0)}.`.trim();
    const count = overrideCount ?? r.number_of_people ?? null;
    const label = overrideLabel
      ?? (isSurfReservation(r)
        ? courseLabel(r)
        : (packageLabel(r) ? `${packageLabel(r)} (${r.accommodation_type ?? "room"})` : (r.accommodation_type ? `${r.accommodation_type} room` : "")));
    return (
      <div className={`mb-1 p-1.5 rounded text-xs border-l-2 ${customerColor(r)}`}>
        <div className="font-medium truncate">
          {displayName}{count ? ` - ${count}` : ""}
        </div>
        <div className="truncate opacity-70">{label}</div>
      </div>
    );
  };

  // FIX 6: expand a surf reservation into separate group + private entries if mixed
  const expandSurfCards = (r: Reservation): { r: Reservation; label?: string; count?: number }[] => {
    const nonSwimmers = r.number_of_non_swimmers ?? 0;
    const total = r.number_of_people ?? 1;
    const swimmers = total - nonSwimmers;
    if (nonSwimmers > 0 && swimmers > 0) {
      return [
        { r, label: courseLabel(r), count: swimmers },
        { r, label: "Private Lesson (non-swimmers)", count: nonSwimmers },
      ];
    }
    if (nonSwimmers > 0 && swimmers === 0) {
      return [{ r, label: "Private Lesson", count: nonSwimmers }];
    }
    return [{ r, label: courseLabel(r), count: total }];
  };

  const MoreButton = ({ date, all }: { date: Date; all: Reservation[] }) => (
    <button
      className="w-full rounded px-1 py-0.5 text-left text-xs font-medium text-primary hover:bg-primary/10"
      onClick={() => setModal({ date, reservations: all })}
    >
      +{all.length - MAX_VISIBLE} more
    </button>
  );

  return (
    <div className="space-y-4 md:space-y-6">
      {modal && (
        <DayModal
          date={modal.date}
          reservations={modal.reservations}
          onClose={() => setModal(null)}
        />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground md:text-2xl">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            {activeTab === "reservations" ? "Weekly view of all reservations" : "Room occupancy by type, per day"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setCurrentDate(addDays(currentDate, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={() => setCurrentDate(new Date())}>Today</Button>
          <Button variant="outline" size="icon" onClick={() => setCurrentDate(addDays(currentDate, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
        <button
          onClick={() => setActiveTab("reservations")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            activeTab === "reservations" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Reservations
        </button>
        <button
          onClick={() => setActiveTab("occupation")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            activeTab === "occupation" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Room Occupation
        </button>
      </div>

      {activeTab === "occupation" ? (
        <RoomOccupationView reservations={reservations} weekStart={weekStart} weekDays={weekDays} />
      ) : (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base md:text-lg">
            {format(weekStart, "MMMM d")} – {format(addDays(weekStart, 6), "MMMM d, yyyy")}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <div className="grid grid-cols-8 min-w-[640px]">

              {/* Header row */}
              <div className="p-2 border-b border-r text-xs font-medium text-muted-foreground">Time</div>
              {weekDays.map((day) => (
                <div
                  key={day.toISOString()}
                  className={`p-2 border-b text-center ${isSameDay(day, new Date()) ? "bg-primary/10 font-bold" : ""}`}
                >
                  <div className="text-xs text-muted-foreground">{format(day, "EEE")}</div>
                  <div className="text-sm md:text-lg">{format(day, "d")}</div>
                </div>
              ))}

              {/* Time slot rows — surf reservations (multi-day courses block all days) */}
              {timeSlots.map((time) => (
                <>
                  <div key={`time-${time}`} className="p-2 border-r border-b text-xs font-medium">{time}</div>
                  {weekDays.map((day) => {
                    const all = getSurfReservationsForDay(day).filter(
                      (r) => r.course_time === time || !r.course_time
                    );
                    const visible = all.slice(0, MAX_VISIBLE);
                    return (
                      <div
                        key={`${day.toISOString()}-${time}`}
                        className="p-1 border-b min-h-20 cursor-pointer hover:bg-muted/30"
                        onClick={() => all.length > 0 && setModal({ date: day, reservations: all })}
                      >
                        {/* FIX 5&6: expand mixed groups into separate cards */}
                        {visible.flatMap((r) => expandSurfCards(r)).slice(0, MAX_VISIBLE).map((entry, i) => (
                          <ReservationCard key={`${entry.r.id}-${i}`} r={entry.r} overrideLabel={entry.label} overrideCount={entry.count} />
                        ))}
                        {all.length > MAX_VISIBLE && (
                          <MoreButton date={day} all={all} />
                        )}
                      </div>
                    );
                  })}
                </>
              ))}

              {/* Accommodation row — blocks check_in through day before check_out */}
              <div className="p-2 border-r text-xs font-medium">Stay</div>
              {weekDays.map((day) => {
                const all = getAccReservationsForDay(day);
                const visible = all.slice(0, MAX_VISIBLE);
                return (
                  <div
                    key={`acc-${day.toISOString()}`}
                    className="p-1 min-h-14 cursor-pointer hover:bg-muted/30"
                    onClick={() => all.length > 0 && setModal({ date: day, reservations: all })}
                  >
                    {visible.map((r) => <ReservationCard key={r.id} r={r} />)}
                    {all.length > MAX_VISIBLE && (
                      <MoreButton date={day} all={all} />
                    )}
                  </div>
                );
              })}

            </div>
          </div>
        </CardContent>
      </Card>
      )}
    </div>
  );
}
