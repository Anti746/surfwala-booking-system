"use client";

import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { courses, accommodationTypes } from "@/lib/mock-data";
import { ChatStep, ReservationFormData, RoomKeyType } from "@/lib/types";
import { ROOM_INVENTORY } from "@/lib/room-inventory";
import {
  SEASONS, ROOM_LABELS, PACKAGE_EXTRA_PERSON_COURSE_PRICE,
  getSeasonForDate, isSurfAndStayBlackout, accTypeToRoomKey,
  getSeasonalPerNightPrice, calcPackagePrice,
  calcStayPrice, calcExtraBedPrice, calcPackageRoomPrice, isRoomOfferedForStay,
  refreshSeasonalPricingFromApi, type RoomKey,
} from "@/lib/pricing";
import {
  formatDateLocal, addDays, nightsBetween, calcRooms,
  formatCourseOption, sortCoursesPrivateFirst,
  safeFetchJson, isValidEmail,
} from "@/lib/chat-helpers";

interface Message {
  id: string;
  type: "bot" | "user";
  text: string;
  options?: string[];
  dealOption?: string; // which option gets DEAL badge
}

const BOOKING_TYPES = ["Surf Lessons", "Accommodation", "Surf + Stay Package"];
const DEFAULT_TIME: "08:00" | "10:00" = "08:00";
const TIME_SLOTS: ("08:00" | "10:00")[] = ["08:00", "10:00"];

// All utility functions are imported from @/lib/chat-helpers and @/lib/pricing above.
// No local redefinitions here — duplicates caused "defined multiple times" build errors.

const initialMessages: Message[] = [
  {
    id: "1",
    type: "bot",
    text: "Hey! Welcome to Surf Wala - Goa's premier surf school! What would you like to book?",
    options: BOOKING_TYPES,
    dealOption: "Surf + Stay Package",
  },
];

interface DayAvailability {
  available: boolean;
  remainingCapacity: number;
}

export function ChatDemo() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [inputValue, setInputValue] = useState("");
  const [currentStep, setCurrentStep] = useState<ChatStep>("booking_type");
  const [formData, setFormData] = useState<Partial<ReservationFormData>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [isLoadingCalendar, setIsLoadingCalendar] = useState(false);
  const [monthOffset, setMonthOffset] = useState(0);
  const [availabilityMap, setAvailabilityMap] = useState<Record<string, DayAvailability>>({});
  // Stores per-type availability for the selected date range: { fan: 1, ac: 3, premium_fan: 1, premium_ac: 3 }
  const [rangeRoomAvailability, setRangeRoomAvailability] = useState<Record<string, number>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Tracks the most recent loadCalendarAvailability call so stale/slow responses
  // from an earlier call can never overwrite results from a newer one (race condition guard)
  const calendarRequestIdRef = useRef(0);

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load live seasonal pricing from the dashboard-editable API once on mount,
  // so price changes made in Accommodation → Seasonal Pricing take effect here.
  useEffect(() => {
    refreshSeasonalPricingFromApi();
  }, []);

  // Ensure surf calendar never shows a blocked (Jun/Jul/Aug) month, regardless of state timing
  useEffect(() => {
    if (currentStep === "date_selection") {
      const min = minSurfMonthOffset();
      if (monthOffset < min) setMonthOffset(min);
    }
  }, [currentStep, monthOffset]);

  // Live accommodation types from API
  const { data: liveAccTypes } = useSWR<{ id: string; name: string; type: string; price_per_night: number; has_ac: boolean }[]>(
    "/api/accommodation",
    async (url: string) => { const r = await fetch(url); return r.json(); }
  );
  const accTypes = liveAccTypes ?? accommodationTypes.map((a) => ({
    id: a.id, name: a.name, type: a.type, price_per_night: a.pricePerNight, has_ac: a.hasAC,
  }));

  const addMessage = (message: Omit<Message, "id">) => {
    setMessages((prev) => [...prev, { ...message, id: `${Date.now()}-${Math.random()}` }]);
  };

  const resetChat = () => {
    setMessages(initialMessages);
    setCurrentStep("booking_type");
    setFormData({});
    setInputValue("");
    setAvailabilityMap({});
    setRangeRoomAvailability({});
    setMonthOffset(0);
    calendarRequestIdRef.current++; // invalidate any in-flight calendar requests from before reset
  };

  // Room option label with exact stay pricing: per-night for single-season
  // stays, full total when the stay spans seasons (matches summary exactly).
  const stayRoomLabel = (a: { name: string; type: string }): string => {
    const ci = formData.checkIn || formatDateLocal(new Date());
    const co = formData.checkOut || addDays(ci, 1);
    const stay = calcStayPrice(a.type, ci, co);
    return stay.spansSeasons
      ? `${a.name} - ${stay.total.toLocaleString()} Rs total (${stay.nights} nights, spans seasons)`
      : `${a.name} - ${(stay.breakdown[0]?.perNight ?? 0).toLocaleString()} Rs/night`;
  };

  // Surf lessons are never available June, July, August (monsoon, every year)
  const isSurfBlockedMonth = (dateStr: string) => {
    const m = parseInt(dateStr.split("-")[1], 10); // 1-12
    return m === 6 || m === 7 || m === 8;
  };

  // A multi-day surf course/package starting on `startDate` and lasting `days`
  // days must not EXTEND into a blocked period either — check every day of the
  // range, not just the start. (e.g. 7-day course starting May 28 runs into June;
  // 7-day package starting Dec 15 runs into the Dec 20+ blackout.)
  const rangeTouchesSurfBlockedMonth = (startDate: string, days: number): boolean => {
    for (let i = 0; i < days; i++) {
      if (isSurfBlockedMonth(addDays(startDate, i))) return true;
    }
    return false;
  };

  const rangeTouchesBlackout = (startDate: string, days: number): boolean => {
    for (let i = 0; i < days; i++) {
      if (isSurfAndStayBlackout(addDays(startDate, i))) return true;
    }
    return false;
  };

  // For surf calendars, returns the smallest monthOffset (from current month) that is NOT June/July/August
  const minSurfMonthOffset = () => {
    const now = new Date();
    for (let off = 0; off <= 11; off++) {
      const m = ((now.getMonth() + off) % 12) + 1;
      if (m !== 6 && m !== 7 && m !== 8) return off;
    }
    return 0;
  };

  const getCalendarDates = (forceOffset?: number) => {
    const dates: string[] = [];
    const now = new Date();
    const effectiveOffset = forceOffset ?? monthOffset;
    const start = new Date(now.getFullYear(), now.getMonth() + effectiveOffset, 1);
    const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    for (let i = 0; i < daysInMonth; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (d >= today) {
        dates.push(formatDateLocal(d));
      }
    }
    return dates;
  };

  const loadCalendarAvailability = async (
    mode: "surf" | "room" | "package",
    accommodationType?: string,
    offsetOverride?: number
  ) => {
    const requestId = ++calendarRequestIdRef.current;
    setIsLoadingCalendar(true);
    let forceOffset: number | undefined;
    if (mode === "surf" || mode === "package") {
      const minOffset = minSurfMonthOffset();
      if (monthOffset < minOffset) {
        forceOffset = minOffset;
        setMonthOffset(minOffset);
      }
    }
    const dates = getCalendarDates(offsetOverride ?? forceOffset);
    try {
      const results = await Promise.all(
        dates.map(async (date) => {
          try {
            if (mode === "room") {
              const roomQuery = currentStep === "check_out_date" && formData.checkIn
                ? `type=room&check_in=${formData.checkIn}&check_out=${date}`
                : `type=room&date=${date}`;
              const url = `/api/availability?${roomQuery}${accommodationType ? `&accommodation_type=${accommodationType}` : ""}`;
              const { ok, data } = await safeFetchJson(url);
              if (!ok || !Array.isArray(data)) {
                return [date, { available: false, remainingCapacity: 0 }] as const;
              }
              const rooms = Array.isArray(data) ? data : [];
              // Only count room types actually offered in this date's season —
              // otherwise a date can show "available" purely because a
              // season-excluded type (e.g. Fan in Loafer season) is free,
              // which then fails once the real range check applies the season filter.
              const seasonForDate = getSeasonForDate(date);
              const freeRooms = rooms.filter((r: any) => {
                if (!r?.available) return false;
                const t = r?.room?.accommodation_type?.type as RoomKey | undefined;
                return t ? (seasonForDate.perNight[t] ?? 0) > 0 : false;
              }).length;
              return [date, { available: freeRooms > 0, remainingCapacity: freeRooms }] as const;
            }
            if (mode === "package") {
              const days = formData.packageDays ?? 3;
              if (rangeTouchesSurfBlockedMonth(date, days) || rangeTouchesBlackout(date, days)) {
                return [date, { available: false, remainingCapacity: 0 }] as const;
              }
              const checkOutDate = addDays(date, days);
              const offeredThisSeason = (Object.keys(ROOM_LABELS) as RoomKey[]).filter((k) => calcPackageRoomPrice(k, date, days as 3 | 5 | 7) !== null);
              if (offeredThisSeason.length === 0) {
                return [date, { available: false, remainingCapacity: 0 }] as const;
              }

              // Surf + Stay needs both a room for the whole stay and surf capacity
              // on every surf day. Never mark a date green from room availability alone.
              const [roomResponse, ...surfResponses] = await Promise.all([
                safeFetchJson(`/api/availability?type=room&check_in=${date}&check_out=${checkOutDate}`),
                ...Array.from({ length: days }, (_, index) => safeFetchJson(`/api/availability?date=${addDays(date, index)}`)),
              ]);
              if (!roomResponse.ok || !Array.isArray(roomResponse.data) || surfResponses.some((response) => !response.ok || !response.data || typeof response.data.available !== "boolean")) {
                return [date, { available: false, remainingCapacity: 0 }] as const;
              }

              const availByType: Record<string, number> = {};
              for (const entry of roomResponse.data) {
                const rawType = entry?.room?.accommodation_type?.type ?? "";
                const roomType = accTypeToRoomKey(rawType);
                if (roomType) availByType[roomType] = (availByType[roomType] ?? 0) + 1;
              }
              // Package capacity is limited by both resources: surf places and
              // the physical rooms available for the complete stay. Never show
              // more places than the eight rooms in the inventory.
              const freeRooms = offeredThisSeason.reduce(
                (total, key) => total + (availByType[key] ?? 0),
                0
              );
              const surfRemaining = Math.min(...surfResponses.map((response) => Number(response.data.remainingCapacity ?? 0)));
              const packageRemaining = Math.min(surfRemaining, freeRooms);
              const available = packageRemaining > 0;
              return [date, { available, remainingCapacity: available ? packageRemaining : 0 }] as const;
            }
            // Surf-only mode: a multi-day course must not extend into June-August.
            // Course is chosen before the date, so formData.courseType is known here.
            const courseDaysMap: Record<string, number> = { week: 7, immerse: 5, plunge: 3 };
            const surfCourseDays = courseDaysMap[formData.courseType ?? ""] ?? 1;
            if (rangeTouchesSurfBlockedMonth(date, surfCourseDays)) {
              return [date, { available: false, remainingCapacity: 0 }] as const;
            }
            const { ok, data } = await safeFetchJson(`/api/availability?date=${date}`);
            if (!ok || !data || typeof data.available !== "boolean") {
              return [date, { available: false, remainingCapacity: 0 }] as const;
            }
            return [date, { available: data.available, remainingCapacity: Number(data.remainingCapacity ?? 0) }] as const;
            } catch {
            // Any failed availability check is unknown, not free.
            return [date, { available: false, remainingCapacity: 0 }] as const;
          }
        })
      );
      // Only apply results if this is still the most recent request — discard stale responses
      if (requestId === calendarRequestIdRef.current) {
        setAvailabilityMap(Object.fromEntries(results));
      }
    } finally {
      if (requestId === calendarRequestIdRef.current) {
        setIsLoadingCalendar(false);
      }
    }
  };

  /**
   * After both check-in and check-out are selected, fetch real availability
   * for that date range and decide which room types to show.
   * roomsRequired = total rooms needed by the group.
   */
  const checkRangeAvailabilityAndShowRooms = async (
    checkIn: string,
    checkOut: string,
    roomsRequired: number
  ) => {
    setIsLoadingCalendar(true);
    try {
      const { ok, data } = await safeFetchJson(
        `/api/availability?type=room&check_in=${checkIn}&check_out=${checkOut}`
      );

      // A successful response is always an array — possibly EMPTY if every room
      // of every type is booked for this range. Emptiness must NOT be read as
      // "no bookings yet, so assume full inventory is free" (that caused overbooking).
      const requestFailed = !ok || !Array.isArray(data);
      const rooms = requestFailed ? [] : data;

      // Count available rooms per type — use accTypeToRoomKey to normalize
      // both old DB keys (standard/superior) and new keys (fan/ac/premium_fan/premium_ac)
      const availByType: Record<string, number> = {};
      for (const entry of rooms) {
        const raw: string = entry?.room?.accommodation_type?.type ?? "";
        const t = accTypeToRoomKey(raw);
        if (t) availByType[t] = (availByType[t] ?? 0) + 1;
      }

      // A failed request must never be treated as free inventory.
      // Keep the result empty so the booking step cannot offer unverifiable rooms.
      setRangeRoomAvailability(availByType);

      // A room type is offered only if EVERY night's season offers it —
      // a stay spanning into Loafer season cannot book a Fan room even when
      // the check-in date's season would allow it.
      const checkInDate = checkIn;
      const accTypesAvailableThisSeason = accTypes.filter((at) =>
        isRoomOfferedForStay(at.type, checkIn, checkOut)
      );
      // Room 1 only needs AT LEAST 1 available of a type — it does NOT need
      // roomsRequired available of the SAME type, because rooms 2+ are chosen
      // individually afterward (via the room_selection loop) and CAN be a
      // different type each. Requiring one type to cover the whole group would
      // wrongly exclude e.g. Premium Fan Room (only 1 ever exists) for a
      // 2-room booking, even though "Premium Fan + Premium AC" is a valid mix.
      const typesWithAny = accTypesAvailableThisSeason.filter((at) => (availByType[accTypeToRoomKey(at.type)] ?? 0) > 0);

      if (typesWithAny.length === 0) {
        addMessage({
          type: "bot",
          text: "Unfortunately we are fully booked for this period. Please choose different dates.",
          options: ["← Choose different dates"],
        });
        setCurrentStep("check_in_date");
        loadCalendarAvailability("room");
        return;
      }

      // Option labels show the exact stay price: per-night when one season,
      // full-stay total when the stay spans seasons (matches the summary exactly).
      const roomOptionLabel = (a: { name: string; type: string }): string => {
        const stay = calcStayPrice(a.type, checkIn, checkOut);
        if (!stay.spansSeasons) {
          return `${a.name} - ${(stay.breakdown[0]?.perNight ?? 0).toLocaleString()} Rs/night`;
        }
        return `${a.name} - ${stay.total.toLocaleString()} Rs total (${stay.nights} nights, spans seasons)`;
      };
      const availableOptions = typesWithAny.map(roomOptionLabel);
      if (!requestFailed && typesWithAny.length === 1) {
        const only = typesWithAny[0];
        setCurrentStep("accommodation_type");
        addMessage({
          type: "bot",
          text: `We are almost fully booked. Only ${only.name} is available for this period.`,
          options: [roomOptionLabel(only), "← Choose different dates"],
        });
      } else {
        setCurrentStep("accommodation_type");
        addMessage({
          type: "bot",
          text: "Which type of room would you like?",
          options: [...availableOptions, "← Choose different dates"],
        });
      }
    } finally {
      setIsLoadingCalendar(false);
    }
  };

  const getMonthLabel = (dateStr: string) => new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const getMonthLabelFromOffset = (offsetOverride?: number) => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + (offsetOverride ?? monthOffset), 1);
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };
  const getTodayDate = () => formatDateLocal(new Date());

  // ─── Ask helpers ─────────────────────────────────────────────────────────────

  // For Surf+Stay packages: silently pick a time slot (08:00 preferred) based on
  // remaining capacity for that day. Falls back to 08:00 if availability can't be checked.
  const assignPackageTimeSlot = async (peopleCount: number) => {
    const date = formData.date;
    let chosenTime: "08:00" | "10:00" = "08:00";
    if (date) {
      try {
        const { data } = await safeFetchJson(`/api/availability?date=${date}`);
        const slots = (data as any)?.slots as { "08:00"?: number; "10:00"?: number } | undefined;
        if (slots) {
          const cap08 = slots["08:00"] ?? 0;
          const cap10 = slots["10:00"] ?? 0;
          if (cap08 >= peopleCount) chosenTime = "08:00";
          else if (cap10 >= peopleCount) chosenTime = "10:00";
          else chosenTime = "08:00"; // neither fits fully — default to 08:00, capacity is enforced server-side anyway
        }
      } catch {
        // keep default 08:00 on error
      }
    }
    setFormData((prev) => ({ ...prev, time: chosenTime }));
    askContactName();
  };

  const askCourse = (isSwimmer?: boolean, nonSwimmerCount?: number, totalCount?: number) => {
    const resolvedNonSwimmers = nonSwimmerCount ?? formData.numberOfNonSwimmers ?? 0;
    const resolvedTotal = totalCount ?? (formData.serviceType === "both" ? formData.surfPeople : formData.numberOfPeople) ?? 1;
    const swimmerCount = resolvedTotal - resolvedNonSwimmers;
    const isPackage = formData.serviceType === "both";

    if (isPackage) {
      // Package already includes the surf course for swimmers — only non-swimmers need an extra Private Lesson surcharge
      if (resolvedNonSwimmers > 0) {
        setFormData((prev) => ({ ...prev, courseType: "private" }));
      }
      assignPackageTimeSlot(resolvedTotal);
      return;
    }

    if (resolvedNonSwimmers > 0 && swimmerCount > 0) {
      setCurrentStep("course_type");
      addMessage({
        type: "bot",
        text: `Your group has ${resolvedNonSwimmers} non-swimmer${resolvedNonSwimmers > 1 ? "s" : ""} (Private Lesson only) and ${swimmerCount} swimmer${swimmerCount > 1 ? "s" : ""}. Which course for the swimmers?`,
        options: courses.filter((c) => c.type !== "private" && c.type !== "kids").map(formatCourseOption),
      });
    } else if (isSwimmer === false || resolvedNonSwimmers === resolvedTotal) {
      setCurrentStep("course_type");
      addMessage({
        type: "bot",
        text: "Since none of you are swimmers yet, we can only offer a Private Lesson for your safety. Please also contact us on WhatsApp after booking so we can arrange the details.",
        options: courses.filter((c) => c.type === "private").map(formatCourseOption),
      });
    } else {
      setCurrentStep("course_type");
      addMessage({
        type: "bot",
        text: "Which course would you like?",
        options: sortCoursesPrivateFirst(courses).map(formatCourseOption),
      });
    }
  };

  const askArrivalTime = () => {
    setCurrentStep("arrival_time");
    addMessage({
      type: "bot",
      text: "What's your estimated arrival time?",
      options: ["15:00 - 18:00", "After 18:00"],
    });
  };

  const askSwimmer = (count: number) => {
    setCurrentStep("swimming_ability");
    addMessage({
      type: "bot",
      text: count > 1 ? `Are all ${count} people in your group swimmers?` : "Are you a swimmer?",
      options: ["Yes", "No", "← Back"],
    });
  };

  const askKidsCount = (total: number) => {
    setCurrentStep("kids_count");
    const opts = ["0", ...Array.from({ length: total }, (_, i) => String(i + 1))];
    addMessage({
      type: "bot",
      text: `How many of the ${total} people are children (kids lesson)?`,
      options: [...opts, "← Back"],
    });
  };

  const askPackageSurfKidsCount = (total: number) => {
    setCurrentStep("kids_count");
    if (total === 1) {
      addMessage({
        type: "bot",
        text: "Is that additional surfer a child (Kids course)?",
        options: ["Yes", "No", "← Back"],
      });
      return;
    }
    const opts = ["0", ...Array.from({ length: total }, (_, i) => String(i + 1))];
    addMessage({
      type: "bot",
      text: `Of the ${total} additional surfers, how many are children (Kids course)?`,
      options: [...opts, "← Back"],
    });
  };

  // After surfingCount is known: if more people surf than the free slots
  // included by the rooms/packages booked, ask how many of those ADDITIONAL
  // surfers are kids; otherwise go straight to the swimmer-count question.
  const proceedAfterSurfParticipation = (surfingCount: number) => {
    const includedFree = formData.packageRoomCount ?? 1; // 1 free surfer per room/package booked
    const additionalSurfers = Math.max(0, surfingCount - includedFree);
    if (additionalSurfers > 0) {
      askPackageSurfKidsCount(additionalSurfers);
    } else {
      setFormData((prev) => ({ ...prev, numberOfKids: 0 }));
      askPackageSwimmersCount(Math.min(surfingCount, includedFree) || 1);
    }
  };

  // Package flow swimmer question — asks how many of ALL surfing adults
  // (INCLUDING the organizer(s) whose course is part of the package) can swim.
  // Kids are excluded here (they're always Kids course regardless of swimming).
  const askPackageSwimmersCount = (adults: number) => {
    setCurrentStep("package_swimmer_count");
    if (adults <= 1) {
      addMessage({
        type: "bot",
        text: "Are you a swimmer?",
        options: ["Yes", "No", "← Back"],
      });
      return;
    }
    const opts = Array.from({ length: adults + 1 }, (_, i) => String(i)); // 0..adults
    addMessage({
      type: "bot",
      text: `Out of the ${adults} adults surfing (including you), how many can swim?`,
      options: [...opts, "← Back"],
    });
  };

  // Asks whether people beyond the included-free surfers also want to surf
  // (Surf+Stay only). Each ROOM booked = 1 package = 1 free surf course, so
  // e.g. 2 rooms means 2 people already have surf included, not just 1.
  // NOTE: under-5 status only affects accommodation (free bed) \u2014 it does NOT
  // exclude someone from this question. A young child can still surf (Kids
  // course) if the family wants them to, so we ask about everyone besides
  // the already-included organizer(s), regardless of age.
  const askPackageSurfParticipation = (totalOverride?: number) => {
    const totalPpl = totalOverride ?? formData.surfPeople ?? 1;
    const includedFree = Math.min(formData.packageRoomCount ?? 1, totalPpl);
    const others = totalPpl - includedFree;

    if (others <= 0) {
      setFormData((prev) => ({ ...prev, packageSurfingCount: totalPpl }));
      proceedAfterSurfParticipation(totalPpl);
      return;
    }

    const includedLabel = includedFree === 1 ? "1 person already has" : `${includedFree} people already have`;
    setCurrentStep("package_surf_participation");
    if (others === 1) {
      addMessage({
        type: "bot",
        text: `${includedLabel} the surf course included in your Surf + Stay package. Will the other person in your group also be surfing?`,
        options: ["Yes", "No", "← Back"],
      });
    } else {
      const opts = Array.from({ length: others + 1 }, (_, i) => String(i)); // 0..others
      addMessage({
        type: "bot",
        text: `${includedLabel} the surf course included in your Surf + Stay package. How many of the other ${others} people in your group would also like to surf?`,
        options: [...opts, "← Back"],
      });
    }
  };


  const askKidsUnder5Question = (totalOverride?: number) => {
    const total = totalOverride ?? formData.surfPeople ?? 1;
    // 1 person: no "under 5" question needed — 1 person = 1 room, no extra bed logic
    if (total <= 1) {
      setFormData((prev) => ({ ...prev, packageKidsUnder5: 0, packageRoomOccupants: 1, packageRoomCount: 1 }));
      setCurrentStep("date_selection");
      addMessage({ type: "bot", text: "Now pick your start date for the package." });
      loadCalendarAvailability("package");
      return;
    }
    setCurrentStep("package_kids_under5");
    const opts = Array.from({ length: total + 1 }, (_, i) => String(i));
    addMessage({
      type: "bot",
      text: `Of the ${total} people, how many are children under 5 years old? (Under-5s stay free and don't need their own bed)`,
      options: [...opts, "← Back"],
    });
  };

  const askPackageRoomType = async (dateOverride?: string, indexOverride?: number, roomCountOverride?: number, chosenTypesOverride?: RoomKey[]) => {
    const date = dateOverride || formData.date || formatDateLocal(new Date());
    const index = indexOverride ?? formData.packageRoomTypeIndex ?? 0;
    const roomCount = roomCountOverride ?? formData.packageRoomCount ?? 1;
    const days = formData.packageDays ?? 3;
    const checkOutDate = addDays(date, days);

    // Room types must be offered by EVERY season the package range touches
    // (e.g. Fan room excluded if any night falls in Loafer season).
    const offeredThisSeason = (Object.keys(ROOM_LABELS) as RoomKey[]).filter(
      (k) => calcPackageRoomPrice(k, date, days as 3 | 5 | 7) !== null
    );
    if (offeredThisSeason.length === 0) {
      addMessage({ type: "bot", text: "No room types are available for this period. Please choose a different start date.", options: ["← Back"] });
      setCurrentStep("date_selection");
      loadCalendarAvailability("package");
      return;
    }

    // Check REAL availability for the package's full date range, not just what the season offers
    setIsLoadingCalendar(true);
    let availableNow = offeredThisSeason;
    try {
      const { ok, data } = await safeFetchJson(
        `/api/availability?type=room&check_in=${date}&check_out=${checkOutDate}`
      );
      // A successful response is always an array (possibly EMPTY if every room of
      // every type is booked) — emptiness must NOT be read as "no bookings yet".
      if (ok && Array.isArray(data)) {
        const availByType: Record<string, number> = {};
        for (const entry of data) {
          // availability API now returns fan/ac/premium keys directly
          const t: string = entry?.room?.accommodation_type?.type ?? "";
          if (t) availByType[t] = (availByType[t] ?? 0) + 1;
        }
        const alreadyChosen = chosenTypesOverride ?? formData.packageRoomTypes ?? [];
        const chosenCountByKey: Record<string, number> = {};
        for (const k of alreadyChosen) chosenCountByKey[k] = (chosenCountByKey[k] ?? 0) + 1;

        availableNow = offeredThisSeason.filter((k) => {
          const free = availByType[k] ?? 0;
          const alreadyUsed = chosenCountByKey[k] ?? 0;
          return free - alreadyUsed > 0;
        });
      }
      // If the request failed (ok=false or not an array), fall back to the
      // season-only list rather than blocking the booking entirely.
    } catch {
      // Network error — fall back to season-only list rather than blocking the booking entirely
    } finally {
      setIsLoadingCalendar(false);
    }

    if (availableNow.length === 0) {
      addMessage({
        type: "bot",
        text: "Sorry, no rooms are available for this entire period. Please choose a different start date.",
        options: ["← Back"],
      });
      setCurrentStep("date_selection");
      loadCalendarAvailability("package");
      return;
    }

    setCurrentStep("package_room_type");
    setFormData((prev) => ({ ...prev, packageRoomTypeIndex: index }));
    const opts = availableNow.map((k) => ROOM_LABELS[k]);
    const label = roomCount > 1 ? `Which room type for room ${index + 1} of ${roomCount}?` : "Which room type would you like?";
    addMessage({
      type: "bot",
      text: label,
      options: [...opts, "← Back"],
    });
  };

  const askGroupSize = (text = "How many people will be joining?") => {
    setCurrentStep("group_size");
    addMessage({
      type: "bot",
      text,
      options: ["1 person", "2 people", "3 people", "4 people", "5+ people (group)"],
    });
  };


  const askChildrenUnder5 = (totalPeople: number, backStep: ChatStep) => {
    setCurrentStep("child_count_pre");
    const options = ["0", ...Array.from({ length: totalPeople }, (_, i) => String(i + 1))];
    addMessage({
      type: "bot",
      text: `How many of the ${totalPeople} guests are children under 5 years old?`,
      options: [...options, "← Back"],
    });
  };
  const askContactName = () => {
    setCurrentStep("contact_name");
    addMessage({ type: "bot", text: "Great! What's your first and last name for the booking?", options: ["← Back"] });
  };

  /**
   * Called after we know: accType (first room type), adults count, children under 5.
   * Starts the room-by-room selection loop with progress text.
   * roomsRequired = total rooms needed by the group.
   */
  const startRoomSelectionLoop = (
    accType: string | undefined,
    adults: number,
    roomsRequired: number
  ) => {
    // 1 person fits alone in 1 room — no extra. Extra only for 3,5,7...
    const hasExtra = adults > 1 && adults % 2 !== 0;

    if (roomsRequired <= 1) {
      // Only 1 room needed — already selected accType
      setFormData((prev) => ({ ...prev, numberOfRooms: 1, roomSelectionsLeft: 0, extraRoomTypes: [], hasExtraPerson: hasExtra }));
      if (hasExtra) {
        // FIX 1&4: odd number of adults — always ask extra bed/room
        askExtraBedOrRoom();
      } else {
        askArrivalTime();
      }
      return;
    }

    // Need rooms 2..N — ask each in sequence with progress text
    const additionalRooms = roomsRequired - 1;
    setFormData((prev) => ({
      ...prev,
      numberOfRooms: roomsRequired,
      roomSelectionsLeft: additionalRooms,
      hasExtraPerson: hasExtra,
      extraRoomTypes: [],
    }));
    // Use same filtered pool as checkRangeAvailabilityAndShowRooms computed —
    // a room type must be offered by EVERY night's season of the stay.
    const ciLoop = formData.checkIn || formatDateLocal(new Date());
    const coLoop = formData.checkOut || addDays(ciLoop, 1);
    const loopPool = accTypes.filter((at) =>
      isRoomOfferedForStay(at.type, ciLoop, coLoop) &&
      (rangeRoomAvailability[accTypeToRoomKey(at.type)] ?? 0) >= roomsRequired
    );
    if (loopPool.length === 0) {
      addMessage({ type: "bot", text: "We don't have enough rooms of any single type available for this period. Please choose different dates.", options: ["← Choose different dates"] });
      setCurrentStep("check_in_date");
      loadCalendarAvailability("room");
      return;
    }
    const loopOptions = loopPool.map((a) => {
      const stay = calcStayPrice(a.type, ciLoop, coLoop);
      return stay.spansSeasons
        ? `${a.name} - ${stay.total.toLocaleString()} Rs total (${stay.nights} nights, spans seasons)`
        : `${a.name} - ${(stay.breakdown[0]?.perNight ?? 0).toLocaleString()} Rs/night`;
    });
    setCurrentStep("room_selection");
    addMessage({
      type: "bot",
      text: `You need ${roomsRequired} rooms total. Selecting room 1 of ${roomsRequired} (already set). Which room type for room 2 of ${roomsRequired}?`,
      options: [...loopOptions, "← Back"],
    });
  };

  const askExtraBedOrRoom = () => {
    setCurrentStep("extra_bed_choice");
    addMessage({
      type: "bot",
      text: "You have 1 extra person. Would you like:\n- Extra bed in one room (+1000 Rs/night)\n- A separate additional room",
      options: ["Extra Bed (+1000 Rs/night)", "Second Room", "← Back"],
    });
  };

  // ─── submitReservation ────────────────────────────────────────────────────────
  const submitReservation = async (current: Partial<ReservationFormData>) => {
    setIsSubmitting(true);

    const wantsSurf = current.serviceType === "surf" || current.serviceType === "both";
    const wantsStay = current.serviceType === "accommodation" || current.serviceType === "both";

    if (!current.name?.trim()) {
      addMessage({ type: "bot", text: "Name is required. Please try again.", options: ["Try Again", "Start Over"] });
      setIsSubmitting(false); return;
    }
    if (!current.email || !isValidEmail(current.email)) {
      addMessage({ type: "bot", text: "A valid email is required. Please try again.", options: ["Try Again", "Start Over"] });
      setIsSubmitting(false); return;
    }
    if (wantsSurf && current.serviceType !== "both" && !current.courseType) {
      addMessage({ type: "bot", text: "Course type is required. Please try again.", options: ["Try Again", "Start Over"] });
      setIsSubmitting(false); return;
    }
    if (current.serviceType === "both" && (!current.date || !current.packageDays || !current.packageRoomTypes || current.packageRoomTypes.length < (current.packageRoomCount ?? 1))) {
      addMessage({ type: "bot", text: "Package details are incomplete. Please try again.", options: ["Try Again", "Start Over"] });
      setIsSubmitting(false); return;
    }
    if (wantsStay && current.serviceType !== "both" && (!current.checkIn || !current.checkOut)) {
      addMessage({ type: "bot", text: "Check-in and check-out dates are required. Please try again.", options: ["Try Again", "Start Over"] });
      setIsSubmitting(false); return;
    }

    const nameParts = (current.name || "").trim().split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || firstName;

    const notes: string[] = [];
    if (wantsSurf) {
      if (current.surfedBefore) {
        const school = current.surfSchool === "Other" ? `Other (${current.surfLocation || "unknown"})` : "SurfWala";
        notes.push(`Surfed before: Yes | School: ${school} | Sessions: ${current.sessionsCount || "unknown"}`);
      } else {
        notes.push("Surfed before: No");
      }
      if ((current.numberOfKids ?? 0) > 0) {
        notes.push(`Kids (Kids Lesson): ${current.numberOfKids}`);
      }
      if ((current.numberOfNonSwimmers ?? 0) > 0) {
        const total = current.serviceType === "both" ? current.packageSurfingCount ?? current.surfPeople ?? 1 : current.numberOfPeople ?? 1;
        const nonKids = total - (current.numberOfKids ?? 0);
        const swimmers = Math.max(0, nonKids - (current.numberOfNonSwimmers ?? 0));
        notes.push(`Non-swimmers: ${current.numberOfNonSwimmers} (Private Lesson) | Swimmers: ${swimmers} | CONTACT VIA WHATSAPP for non-swimmer details`);
      }
    }
    if (current.serviceType === "both") {
      const { season, spansSeasons, roomTotal, kidsExtra, nonSwimmerExtra, swimmerExtra, total } = calcPackagePrice(current);
      const roomTypesStr = current.packageRoomTypes && current.packageRoomTypes.length > 0
        ? current.packageRoomTypes.map((t) => ROOM_LABELS[t]).join(", ")
        : ROOM_LABELS[current.packageRoomType ?? "fan"];
      notes.push(`PACKAGE: ${current.packageDays} Day/${current.packageDays} Night - ${season.label} | Rooms: ${roomTypesStr}${current.packageWantsExtraBed ? " +extra bed" : ""} = ${roomTotal.toLocaleString()} Rs | ${current.packageRoomCount ?? 1} surf course(s) included free (1 per room) | Extra swimmer course(s): ${swimmerExtra.toLocaleString()} Rs | Extra non-swimmer Private Lesson(s): ${nonSwimmerExtra.toLocaleString()} Rs | Extra Kids Lesson(s): ${kidsExtra.toLocaleString()} Rs | TOTAL: ${total.toLocaleString()} Rs | Total people: ${current.surfPeople} (${current.packageKidsUnder5 ?? 0} under 5 free)`);
    }
    if (current.extraRoomType) notes.push(`Extra room: ${current.extraRoomType}`);
    if (current.extraBed) notes.push("Extra bed: Yes (1000 Rs)");
    if (current.hasChildUnder5) notes.push(`Children under 5: ${current.childrenUnder5 ?? 1} (free)`);
    if (current.arrivalTime) notes.push(`Arrival: ${current.arrivalTime}`);
    if (current.contactPreference) notes.push(`Preferred contact: ${current.contactPreference}`);

    const experienceNote = notes.length ? notes.join(" | ") : null;

    // Surf people count — for packages this is how many ACTUALLY surf
    // (may be less than the total group, since some guests may just stay)
    const surfPeople =
      current.serviceType === "both"
        ? current.packageSurfingCount || current.surfPeople || 1
        : current.numberOfPeople || 1;

    // Accommodation people count
    const accPeople =
      current.serviceType === "both"
        ? current.packageRoomOccupants || current.surfPeople || 1
        : current.numberOfPeople || 1;

    // Total rooms needed
    const adultsForRooms = accPeople - ((current.childrenUnder5 as number) ?? 0);
    const roomsNeeded = current.numberOfRooms ?? Math.ceil(adultsForRooms / 2);

    // Build extra_room_types array
    // For packages: packageRoomTypes[0] is the primary type, [1..N] are extras.
    // For accommodation-only: extraRoomTypes + extraRoomType from the room selection loop.
    const extraRoomTypesArr: string[] = current.serviceType === "both"
      ? (current.packageRoomTypes ?? []).slice(1)
      : [...((current.extraRoomTypes as string[]) ?? []), ...(current.extraRoomType ? [current.extraRoomType] : [])];

    // ── Compute authoritative total prices (chatbot is the source of truth for pricing) ──
    let surfTotalPrice = 0;
    let accommodationTotalPrice = 0;

    if (current.serviceType === "both") {
      const { roomTotal, surfExtraTotal } = calcPackagePrice(current);
      accommodationTotalPrice = roomTotal;
      surfTotalPrice = surfExtraTotal; // extra surf course charges beyond the 1 free included
    } else if (wantsSurf) {
      const total = current.numberOfPeople ?? 1;
      const kids = current.numberOfKids ?? 0;
      const nonSwimmers = current.numberOfNonSwimmers ?? 0;
      const nonKids = total - kids;
      const swimmers = nonKids - nonSwimmers;
      const kidsCourse = courses.find((c) => c.type === "kids");
      const privateCourse = courses.find((c) => c.type === "private");
      const mainCourse = courses.find((c) => c.type === current.courseType);
      if (kids > 0 && kidsCourse) surfTotalPrice += kidsCourse.price * kids;
      if (nonSwimmers > 0 && swimmers > 0) {
        if (privateCourse) surfTotalPrice += privateCourse.price * nonSwimmers;
        if (mainCourse) surfTotalPrice += mainCourse.price * swimmers;
      } else if (nonKids > 0 && mainCourse) {
        surfTotalPrice += mainCourse.price * nonKids;
      }
    } else if (wantsStay) {
      // Per-night season-aware pricing: each night billed at its own season's
      // rate (a stay spanning Peaceful→Busy pays exactly per night, not one flat season).
      const ci = current.checkIn || formatDateLocal(new Date());
      const co = current.checkOut || addDays(ci, 1);
      const mainAcc = accTypes.find((a) => accTypeToRoomKey(a.type) === current.accommodationType);
      if (mainAcc) accommodationTotalPrice += calcStayPrice(mainAcc.type, ci, co).total;
      extraRoomTypesArr.forEach((t) => {
        const et = accTypes.find((a) => accTypeToRoomKey(a.type) === t);
        if (et) accommodationTotalPrice += calcStayPrice(et.type, ci, co).total;
      });
      if (current.extraBed) accommodationTotalPrice += calcExtraBedPrice(ci, co);
    }

    try {
      let courseType: string | null = null;
      if (wantsSurf && current.courseType) {
        const selectedCourse = courses.find(
          (c) => c.type === current.courseType || c.name.toLowerCase().includes((current.courseType || "").toLowerCase())
        );
        courseType = selectedCourse?.type ?? current.courseType ?? null;
      }

      const rawTime = current.time;
      const courseTime: string | null = wantsSurf ? (rawTime === "10:00" ? "10:00" : "08:00") : null;

      const isPackage = current.serviceType === "both";
      const packageCourseType = (d?: number): string => {
        if (d === 7) return "week";
        if (d === 5) return "immerse";
        return "plunge"; // default / 3-day
      };
      const payload = {
        // Surf fields (only set when surf)
        course_type: wantsSurf ? (isPackage ? packageCourseType(current.packageDays) : courseType) : null,
        course_date: wantsSurf ? (current.date || current.checkIn || null) : null,
        course_time: courseTime,
        number_of_people: typeof surfPeople === "number" ? surfPeople : 1,
        number_of_non_swimmers: current.numberOfNonSwimmers ?? 0,
        surf_total_price: wantsSurf ? surfTotalPrice : undefined,
        // Accommodation fields (only set when stay)
        // For packages: primary accommodation_type = first chosen room type.
        // extra_room_types = remaining rooms (already in packageRoomTypes[1..N] via extraRoomTypesArr).
        accommodation_type: wantsStay
          ? (isPackage
            ? (current.packageRoomTypes?.[0] ?? current.packageRoomType ?? null)
            : current.accommodationType || null)
          : null,
        check_in: wantsStay ? (isPackage ? current.date || null : current.checkIn || null) : null,
        check_out: wantsStay ? (isPackage && current.date && current.packageDays ? addDays(current.date, current.packageDays) : current.checkOut || null) : null,
        accommodation_people: wantsStay ? accPeople : undefined,
        rooms_needed: wantsStay ? (isPackage ? current.packageRoomCount ?? 1 : roomsNeeded) : undefined,
        extra_room_types: extraRoomTypesArr.length > 0 ? extraRoomTypesArr : undefined,
        accommodation_total_price: wantsStay ? accommodationTotalPrice : undefined,
        // Customer
        customer: { first_name: firstName, last_name: lastName, email: current.email || "", phone: current.phone || "" },
        special_requests: experienceNote,
      };

      const { ok, data } = await safeFetchJson("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!ok) {
        const err = (data as any)?.error || (data as any)?.message || JSON.stringify(data) || "Unknown server error";
        addMessage({ type: "bot", text: `Sorry, there was an error: ${err}. Please try again.`, options: ["Try Again", "Start Over"] });
        setIsSubmitting(false); return;
      }

      const reservation = data as { id?: string } | null;
      if (!reservation?.id) {
        addMessage({ type: "bot", text: "Reservation created but no confirmation ID received. Please contact us.", options: ["Start Over"] });
        setIsSubmitting(false); return;
      }

      addMessage({
        type: "bot",
        text: `Reservation request sent! Your booking reference is #${reservation.id.slice(0, 8).toUpperCase()}. You'll receive a confirmation email once it's approved. See you at Surf Wala!`,
      });
      setCurrentStep("completed");
      setTimeout(() => {
        addMessage({ type: "bot", text: "Would you like to make another booking?", options: ["Yes, start over", "No, thanks"] });
      }, 2000);
    } catch (error) {
      addMessage({ type: "bot", text: "Sorry, something went wrong. Please try again or contact us directly.", options: ["Try Again", "Start Over"] });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOptionClick = (option: string) => {
    addMessage({ type: "user", text: option });
    setTimeout(() => processResponse(option), 400);
  };

  const handleSelectDate = (date: string) => {
    // Range-aware guard: the FULL duration of the course/package must stay
    // outside monsoon (Jun-Aug) and — for packages — outside the blackout.
    if (currentStep === "date_selection") {
      const courseDaysMap: Record<string, number> = { week: 7, immerse: 5, plunge: 3 };
      const durationDays = formData.serviceType === "both"
        ? (formData.packageDays ?? 3)
        : (courseDaysMap[formData.courseType ?? ""] ?? 1);

      if (rangeTouchesSurfBlockedMonth(date, durationDays)) {
        addMessage({ type: "bot", text: "🌊 Surf lessons are not available June–August due to monsoon season. Your course/package must finish before June — please pick an earlier or later start date." });
        return;
      }
      if (formData.serviceType === "both" && rangeTouchesBlackout(date, durationDays)) {
        addMessage({ type: "bot", text: "Sorry, Surf + Stay packages are not available Dec 20 – Jan 7, and your package would run into that period. Please pick an earlier start date, or book Accommodation and Surf Lessons separately." });
        return;
      }
    }
    const info = availabilityMap[date];
    if (info && !info.available) {
      addMessage({ type: "bot", text: "No availability for this date." });
      return;
    }

    if (currentStep === "date_selection") {
      addMessage({ type: "user", text: date });

      if (formData.serviceType === "both") {
        setFormData((prev) => ({ ...prev, date, packageRoomTypes: [] }));
        askPackageRoomType(date, 0, formData.packageRoomCount ?? 1);
        return;
      }

      setFormData((prev) => ({ ...prev, date }));
      const isPrivate = formData.courseType === "private";
      const isNonSwimmer = (formData.numberOfNonSwimmers ?? 0) === (formData.numberOfPeople ?? 1);
      if (isPrivate || isNonSwimmer) {
        setFormData((prev) => ({ ...prev, date, time: DEFAULT_TIME }));
        addMessage({ type: "bot", text: `Surf lesson booked for ${date}.` });
        askContactName();
      } else {
        setCurrentStep("time_selection");
        addMessage({ type: "bot", text: `${date} is available. Which time slot works for you?`, options: [...TIME_SLOTS.map((t) => t), "← Back"] });
      }
      return;
    }

    if (currentStep === "check_in_date") {
      addMessage({ type: "user", text: `Check-in: ${date}` });
      setFormData((prev) => ({ ...prev, checkIn: date }));
      setCurrentStep("check_out_date");
      addMessage({ type: "bot", text: "Now pick your check-out date." });
      loadCalendarAvailability("room");
      return;
    }

    if (currentStep === "check_out_date") {
      if (formData.checkIn && date <= formData.checkIn) {
        addMessage({ type: "bot", text: "Check-out must be after check-in." });
        return;
      }
      addMessage({ type: "user", text: `Check-out: ${date}` });

      // Calculate rooms needed before fetching availability
      const accPeople = formData.serviceType === "both" ? formData.accommodationPeople ?? 1 : formData.numberOfPeople ?? 1;
      const children = (formData.childrenUnder5 as number) ?? 0;
      const adults = accPeople - children;
      const { rooms: roomsNeededRaw } = calcRooms(adults > 0 ? adults : 1);
      // At least 1 room always needed (floor(1/2)=0 would break availability filter)
      const roomsNeeded = Math.max(1, roomsNeededRaw);

      setFormData((prev) => ({ ...prev, checkOut: date, numberOfRooms: roomsNeeded }));

      // Now fetch availability for this range and show room options
      checkRangeAvailabilityAndShowRooms(formData.checkIn!, date, roomsNeeded);
      return;
    }
  };

  // ─── Build summary ────────────────────────────────────────────────────────────
  // calcPackagePrice is imported from @/lib/pricing — no local copy needed.
  const buildSummary = (data: Partial<ReservationFormData>) => {
    const wantsSurf = data.serviceType === "surf" || data.serviceType === "both";
    const wantsStay = data.serviceType === "accommodation" || data.serviceType === "both";
    let s = "Here's your booking summary:\n\n";

    if (data.serviceType === "both") {
      const days = data.packageDays ?? 3;
      const { season, spansSeasons, roomTotal, kidsExtra, nonSwimmerExtra, swimmerExtra, total } = calcPackagePrice(data);
      const roomTypesList = data.packageRoomTypes && data.packageRoomTypes.length > 0
        ? data.packageRoomTypes.map((t) => ROOM_LABELS[t]).join(", ")
        : ROOM_LABELS[data.packageRoomType ?? "fan"];
      s += `Package: ${days} Day Course with ${days} Nights (${season.label})\n`;
      s += `Rooms: ${roomTypesList} - ${roomTotal.toLocaleString()} Rs`;
      if (data.packageWantsExtraBed) s += ` (incl. extra bed)`;
      s += `\n`;
      const includedFreeCourses = data.packageRoomCount ?? 1;
      s += includedFreeCourses === 1
        ? `1 surf course included in the package (free)\n`
        : `${includedFreeCourses} surf courses included in the package (free — 1 per room)\n`;
      if (swimmerExtra > 0) s += `Extra surf course(s) for swimmers: ${swimmerExtra.toLocaleString()} Rs\n`;
      if (nonSwimmerExtra > 0) {
        const privatePrice = courses.find((c) => c.type === "private")?.price ?? 0;
        s += `Extra Private Lesson(s) for non-swimmers: ${nonSwimmerExtra.toLocaleString()} Rs (${privatePrice.toLocaleString()} Rs/lesson)\n`;
      }
      if (kidsExtra > 0) {
        const kidsPrice = courses.find((c) => c.type === "kids")?.price ?? 0;
        s += `Extra Kids Lesson(s): ${kidsExtra.toLocaleString()} Rs (${kidsPrice.toLocaleString()} Rs/lesson)\n`;
      }
      s += `Total package price: ${total.toLocaleString()} Rs\n`;
      if (spansSeasons) s += `(Your package spans two seasons — each night is billed at its own season's rate.)\n`;
      s += `Total people staying: ${data.surfPeople}${(data.packageKidsUnder5 ?? 0) > 0 ? ` (incl. ${data.packageKidsUnder5} under 5, free)` : ""}\n`;
      if ((data.packageSurfingCount ?? data.surfPeople ?? 1) !== data.surfPeople) {
        s += `People surfing: ${data.packageSurfingCount}\n`;
      }
      s += `Start date: ${data.date}\n`;
      if (data.time) s += `Surf time: ${data.time}\n`;
      s += `Surfed before: ${data.surfedBefore ? "Yes" : "No"}\n`;
      if (data.surfedBefore && data.surfSchool) {
        s += `School: ${data.surfSchool === "Other" ? `Other (${data.surfLocation})` : "SurfWala"}, ${data.sessionsCount}\n`;
      }
      s += `\nName: ${data.name}\nPhone: ${data.phone}\nEmail: ${data.email}`;
      if (data.contactPreference) s += `\nPreferred contact: ${data.contactPreference}`;
      s += `\n\nNote: a deposit is required to confirm your reservation.`;
      if ((data.numberOfNonSwimmers ?? 0) > 0) {
        s += `\nNote: your group includes non-swimmer(s) — please contact us on WhatsApp for further details.`;
      }
      return s;
    }

    let surfTotal = 0;
    if (wantsSurf) {
      const total = data.numberOfPeople ?? 1;
      const kids = data.numberOfKids ?? 0;
      const nonSwimmers = data.numberOfNonSwimmers ?? 0;
      const nonKids = total - kids;
      const swimmers = nonKids - nonSwimmers;

      if (kids > 0) {
        const kidsCourse = courses.find((c) => c.type === "kids");
        if (kidsCourse) {
          const lineTotal = kidsCourse.price * kids;
          surfTotal += lineTotal;
          s += `Kids (${kids}x): ${kidsCourse.name} - ${lineTotal.toLocaleString()} Rs (${kids} × ${kidsCourse.price.toLocaleString()} Rs/lesson)\n`;
        }
      }
      if (nonSwimmers > 0 && swimmers > 0) {
        const privateCourse = courses.find((c) => c.type === "private");
        const mainCourse = courses.find((c) => c.type === data.courseType);
        if (privateCourse) {
          const lineTotal = privateCourse.price * nonSwimmers;
          surfTotal += lineTotal;
          s += `Non-swimmers (${nonSwimmers}): ${privateCourse.name} - ${lineTotal.toLocaleString()} Rs (${nonSwimmers} × ${privateCourse.price.toLocaleString()} Rs/lesson)\n`;
        }
        if (mainCourse) {
          const lineTotal = mainCourse.price * swimmers;
          surfTotal += lineTotal;
          s += `Swimmers (${swimmers}): ${mainCourse.name} - ${lineTotal.toLocaleString()} Rs\n`;
        }
      } else if (nonKids > 0) {
        const course = courses.find((c) => c.type === data.courseType);
        if (course) {
          const lineTotal = course.price * nonKids;
          surfTotal += lineTotal;
          s += `Course (${nonKids}x): ${course.name} - ${lineTotal.toLocaleString()} Rs\n`;
        }
      }
      if (data.date) s += `Lesson date: ${data.date}\n`;
      if (data.time) s += `Lesson time: ${data.time}\n`;
      if (kids > 0) s += `Kids in group: ${kids}\n`;
      if (nonSwimmers > 0) s += `Non-swimmers: ${nonSwimmers}\n`;
      s += `Surfed before: ${data.surfedBefore ? "Yes" : "No"}\n`;
      if (data.surfedBefore && data.surfSchool) {
        s += `School: ${data.surfSchool === "Other" ? `Other (${data.surfLocation})` : "SurfWala"}, ${data.sessionsCount}\n`;
      }
    }

    let accTotal = 0;
    if (wantsStay) {
      const ci = data.checkIn || formatDateLocal(new Date());
      const co = data.checkOut || addDays(ci, 1);

      // Per-night season-aware pricing with a transparent breakdown when the
      // stay crosses a season boundary (e.g. "3 nights × 4,000 + 2 nights × 5,000").
      const formatStayLine = (label: string, accTypeDb: string, accName: string): string => {
        const stay = calcStayPrice(accTypeDb, ci, co);
        accTotal += stay.total;
        if (!stay.spansSeasons) {
          const row = stay.breakdown[0];
          return `${label}: ${accName} - ${row?.perNight.toLocaleString() ?? 0} Rs/night × ${stay.nights} night${stay.nights > 1 ? "s" : ""} = ${stay.total.toLocaleString()} Rs\n`;
        }
        // Spans seasons — show the exact per-season split
        let line = `${label}: ${accName} - ${stay.total.toLocaleString()} Rs (stay spans seasons:`;
        line += stay.breakdown.map((b) => ` ${b.nights} night${b.nights > 1 ? "s" : ""} × ${b.perNight.toLocaleString()}`).join(" +");
        line += `)\n`;
        return line;
      };

      const acc = accTypes.find((a) => accTypeToRoomKey(a.type) === data.accommodationType);
      if (acc) s += formatStayLine("Room 1", acc.type, acc.name);

      const extraTypes: string[] = (data as any).extraRoomTypes ?? [];
      extraTypes.forEach((t, i) => {
        const et = accTypes.find((a) => accTypeToRoomKey(a.type) === t);
        if (et) s += formatStayLine(`Room ${i + 2}`, et.type, et.name);
      });
      if (data.extraRoomType) {
        const extra = accTypes.find((a) => accTypeToRoomKey(a.type) === data.extraRoomType);
        if (extra) s += formatStayLine("Extra room", extra.type, extra.name);
      }
      if (data.extraBed) {
        const extraBedTotal = calcExtraBedPrice(ci, co);
        const nights = nightsBetween(ci, co);
        accTotal += extraBedTotal;
        s += `Extra bed: ${extraBedTotal.toLocaleString()} Rs (${nights} night${nights > 1 ? "s" : ""})\n`;
      }
      if (data.hasChildUnder5) s += `Child under 5: free\n`;
      s += `Check-in: ${data.checkIn}\nCheck-out: ${data.checkOut}\n`;
      if (data.arrivalTime) s += `Arrival: ${data.arrivalTime}\n`;
    }

    s += `People: ${data.numberOfPeople}\n`;
    const grandTotal = surfTotal + accTotal;
    s += `\nTotal price: ${grandTotal.toLocaleString()} Rs\n`;
    s += `\nName: ${data.name}\nPhone: ${data.phone}\nEmail: ${data.email}`;
    if (data.contactPreference) s += `\nPreferred contact: ${data.contactPreference}`;
    s += `\n\nNote: a deposit is required to confirm your reservation.`;
    const wantsSurfHere = data.serviceType === "surf";
    if (wantsSurfHere && (data.numberOfNonSwimmers ?? 0) > 0) {
      s += `\nNote: your group includes non-swimmer(s) — please contact us on WhatsApp for further details.`;
    }
    return s;
  };

  // ─── Main router ──────────────────────────────────────────────────────────────
  const processResponse = (userInput: string) => {
    const input = userInput.toLowerCase();

    if (currentStep === "completed") {
      if (input.includes("yes") || input.includes("start")) resetChat();
      else if (input.includes("no") || input.includes("thanks")) setIsVisible(false);
      return;
    }

    switch (currentStep) {

      // ── STEP 1 ──────────────────────────────────────────────────────────────
      case "booking_type": {
        if (input.includes("accommodation")) {
          setFormData({ serviceType: "accommodation" });
          askGroupSize("How many people need accommodation?");
        } else if (input.includes("package") || input.includes("stay")) {
          setFormData({ serviceType: "both" });
          setCurrentStep("package_days");
          addMessage({
            type: "bot",
            text: "Great choice! Our Surf + Stay packages run for 3, 5, or 7 days. Which would you like?\n\nNote: exact pricing depends on the season of your stay — you'll see the price once you pick your dates.",
            options: ["3 Day Course with 3 Nights", "5 Day Course with 5 Nights", "7 Day Course with 7 Nights", "← Back"],
          });
        } else {
          setFormData({ serviceType: "surf" });
          askGroupSize("How many people are joining the surf lesson?");
        }
        break;
      }

      // ── GROUP SIZE (surf-only / accommodation-only) ──────────────────────────
      case "group_size": {
        if (input.includes("back")) {
          setCurrentStep("booking_type");
          addMessage({ type: "bot", text: "What would you like to book?", options: BOOKING_TYPES });
          break;
        }
        const m = input.match(/(\d+)/);
        const n = m ? parseInt(m[1]) : 1;
        if (n >= 5) {
          setFormData((prev) => ({ ...prev, numberOfPeople: n }));
          setCurrentStep("large_group_size");
          addMessage({
            type: "bot",
            text: "How many people exactly?",
            options: ["5", "6", "7", "8", "9", "10", "11", "12", "← Back"],
          });
        } else {
          setFormData((prev) => ({ ...prev, numberOfPeople: n }));
          if (formData.serviceType === "surf") {
            if (n > 1) {
              askKidsCount(n);
            } else {
              askSwimmer(n);
            }
          } else if (n === 1) {
            // 1 person: no children question, go straight to dates
            setFormData((prev) => ({ ...prev, numberOfPeople: 1, hasChildUnder5: false, childrenUnder5: 0 }));
            setCurrentStep("check_in_date");
            addMessage({ type: "bot", text: "Pick your check-in date. Fully booked days are shown in red." });
            loadCalendarAvailability("room");
          } else {
            // Ask children under 5 before dates
            askChildrenUnder5(n, "group_size");
          }
        }
        break;
      }

      case "large_group_size": {
        if (input.includes("back")) {
          askGroupSize(formData.serviceType === "surf" ? "How many people are joining the surf lesson?" : "How many people need accommodation?");
          break;
        }
        const m = input.match(/(\d+)/);
        const n = m ? parseInt(m[1]) : 5;
        setFormData((prev) => ({ ...prev, numberOfPeople: n }));
        if (formData.serviceType === "surf") {
          askKidsCount(n);
        } else {
          askChildrenUnder5(n, "large_group_size");
        }
        break;
      }

      // ── ACCOMMODATION-ONLY HEADCOUNT ──────────────────────────────────────────
      case "accommodation_people": {
        if (input.includes("back")) {
          setCurrentStep("booking_type");
          addMessage({ type: "bot", text: "What would you like to book?", options: BOOKING_TYPES });
          break;
        }
        const m = input.match(/(\d+)/);
        const n = m ? parseInt(m[1]) : 1;
        if (n >= 5) {
          setFormData((prev) => ({ ...prev, accommodationPeople: n }));
          setCurrentStep("large_acc_people");
          addMessage({
            type: "bot",
            text: "How many people exactly need accommodation?",
            options: ["5", "6", "7", "8", "9", "10", "11", "12", "← Back"],
          });
        } else {
          setFormData((prev) => ({ ...prev, accommodationPeople: n }));
          if (n === 1) {
            setFormData((prev) => ({ ...prev, accommodationPeople: 1, hasChildUnder5: false, childrenUnder5: 0 }));
            setCurrentStep("check_in_date");
            addMessage({ type: "bot", text: "Pick your check-in date. Fully booked days are shown in red." });
            loadCalendarAvailability("room");
          } else {
            askChildrenUnder5(n, "accommodation_people");
          }
        }
        break;
      }

      case "large_acc_people": {
        if (input.includes("back")) {
          setCurrentStep("accommodation_people");
          addMessage({
            type: "bot",
            text: "How many people need accommodation?",
            options: ["1 person", "2 people", "3 people", "4 people", "5+ people (group)", "← Back"],
          });
          break;
        }
        const m = input.match(/(\d+)/);
        const n = m ? parseInt(m[1]) : 5;
        setFormData((prev) => ({ ...prev, accommodationPeople: n }));
        askChildrenUnder5(n, "large_acc_people");
        break;
      }

      // ── HOW MANY CHILDREN UNDER 5? (asked BEFORE date selection) ─────────���─
      case "child_count_pre": {
        if (input.includes("back")) {
          if (formData.serviceType === "both") {
            const accP = formData.accommodationPeople ?? 1;
            if (accP >= 5) {
              setCurrentStep("large_acc_people");
              addMessage({ type: "bot", text: "How many people exactly need accommodation?", options: ["5","6","7","8","9","10","11","12","← Back"] });
            } else {
              setCurrentStep("accommodation_people");
              addMessage({ type: "bot", text: "How many people need accommodation?", options: ["1 person","2 people","3 people","4 people","5+ people (group)","← Back"] });
            }
          } else {
            const accP = formData.numberOfPeople ?? 1;
            if (accP >= 5) {
              setCurrentStep("large_group_size");
              addMessage({ type: "bot", text: "How many people exactly?", options: ["5","6","7","8","9","10","11","12","← Back"] });
            } else {
              askGroupSize("How many people need accommodation?");
            }
          }
          break;
        }
        const mCp = input.match(/(\d+)/);
        const children = mCp ? parseInt(mCp[1]) : 0;
        setFormData((prev) => ({ ...prev, hasChildUnder5: children > 0, childrenUnder5: children }));
        setCurrentStep("check_in_date");
        addMessage({ type: "bot", text: "Pick your check-in date. Fully booked days are shown in red." });
        loadCalendarAvailability("room");
        break;
      }

      // ── HOW MANY CHILDREN UNDER 5? ───────────────────────────────────────────
      // (Now reached after date selection via checkRangeAvailabilityAndShowRooms)
      case "child_count": {
        if (input.includes("back")) {
          setCurrentStep("check_out_date");
          addMessage({ type: "bot", text: "Pick your check-out date." });
          loadCalendarAvailability("room");
          break;
        }
        const m = input.match(/(\d+)/);
        const children = m ? parseInt(m[1]) : 0;
        const accPeople = formData.serviceType === "both" ? formData.accommodationPeople ?? 1 : formData.numberOfPeople ?? 1;
        setFormData((prev) => ({ ...prev, hasChildUnder5: children > 0, childrenUnder5: children }));
        const adults = accPeople - children;
        const { rooms: roomsNeededRaw2 } = calcRooms(adults > 0 ? adults : 1);
        const roomsNeeded = Math.max(1, roomsNeededRaw2);
        setFormData((prev) => ({ ...prev, numberOfRooms: roomsNeeded }));
        checkRangeAvailabilityAndShowRooms(formData.checkIn!, formData.checkOut!, roomsNeeded);
        break;
      }

      // ── ACCOMMODATION TYPE (shown AFTER date selection) ───────────────────────
      case "accommodation_type": {
        if (input.includes("back") || input.includes("different dates")) {
          setCurrentStep("check_in_date");
          addMessage({ type: "bot", text: "Pick your check-in date." });
          loadCalendarAvailability("room");
          break;
        }
        const accPeopleForValidation = formData.serviceType === "both" ? formData.accommodationPeople ?? 1 : formData.numberOfPeople ?? 1;
        const childrenForValidation = (formData.childrenUnder5 as number) ?? 0;
        const adultsForValidation = accPeopleForValidation - childrenForValidation;
        const { rooms: roomsNeededForValidation } = calcRooms(adultsForValidation > 0 ? adultsForValidation : 1);
        const roomsNeededVal = Math.max(1, roomsNeededForValidation);
        const checkInForValidation = formData.checkIn || formatDateLocal(new Date());
        const checkOutForValidation = formData.checkOut || addDays(checkInForValidation, 1);
        const availableTypesNow = accTypes.filter((at) => {
          const roomKey = accTypeToRoomKey(at.type);
          // Offered by EVERY night's season of the stay (not just check-in's season).
          // Room 1 only needs >=1 available — rooms 2+ are chosen individually
          // afterward and can be a different type each (same fix as the display filter).
          const offered = isRoomOfferedForStay(at.type, checkInForValidation, checkOutForValidation);
          const hasAny = (rangeRoomAvailability[roomKey] ?? 0) >= 1;
          return offered && hasAny;
        });
        const sel = availableTypesNow.find((a) => input.includes(a.name.toLowerCase()));
        if (!sel) {
          addMessage({ type: "bot", text: "That room type isn't available for your dates. Please select one of the options shown." });
          break;
        }
        const accType = accTypeToRoomKey(sel.type); // convert standard→fan, superior→ac, premium→premium
        setFormData((prev) => ({ ...prev, accommodationType: accType }));
        setFormData((prev) => ({ ...prev, numberOfRooms: roomsNeededVal }));
        startRoomSelectionLoop(accType, adultsForValidation > 0 ? adultsForValidation : 1, roomsNeededVal);
        break;
      }

      // ── ROOM SELECTION LOOP (rooms 2..N) ────────────────────────────────────
      case "room_selection": {
        if (input.includes("back")) {
          setCurrentStep("accommodation_type");
          const roomsNeeded = formData.numberOfRooms ?? 1;
          const checkInBack = formData.checkIn || formatDateLocal(new Date());
          const checkOutBack = formData.checkOut || addDays(checkInBack, 1);
          // Room 1 only needs >=1 available of a type (rooms 2+ can be a different type each)
          const typesWithEnough = accTypes.filter((at) =>
            isRoomOfferedForStay(at.type, checkInBack, checkOutBack) &&
            (rangeRoomAvailability[accTypeToRoomKey(at.type)] ?? 0) >= 1
          );
          const opts = typesWithEnough.map((a) => {
            const stay = calcStayPrice(a.type, checkInBack, checkOutBack);
            return stay.spansSeasons
              ? `${a.name} - ${stay.total.toLocaleString()} Rs total (${stay.nights} nights, spans seasons)`
              : `${a.name} - ${(stay.breakdown[0]?.perNight ?? 0).toLocaleString()} Rs/night`;
          });
          addMessage({
            type: "bot",
            text: "Which type of room would you like?",
            options: [...opts, "← Choose different dates"],
          });
          break;
        }
        // FIX 3: only accept options that are actually available — never fall back to unfiltered accTypes
        const roomsNeededNow = formData.numberOfRooms ?? 1;
        const checkInForSel = formData.checkIn || formatDateLocal(new Date());
        const checkOutForSel = formData.checkOut || addDays(checkInForSel, 1);
        const availTypes = accTypes.filter((at) =>
          isRoomOfferedForStay(at.type, checkInForSel, checkOutForSel) &&
          (rangeRoomAvailability[accTypeToRoomKey(at.type)] ?? 0) >= roomsNeededNow
        );
        const sel = availTypes.find((a) => input.includes(a.name.toLowerCase()));
        if (!sel) {
          addMessage({ type: "bot", text: "That room type isn't available. Please select one of the options shown." });
          break;
        }

        const existingTypes: string[] = (formData as any).extraRoomTypes ?? [];
        const newTypes = [...existingTypes, sel.type];
        const left = ((formData as any).roomSelectionsLeft ?? 1) - 1;
        const totalRooms = formData.numberOfRooms ?? 1;
        const roomIndex = newTypes.length + 1; // +1 because room 1 already chosen

        setFormData((prev) => ({ ...prev, extraRoomTypes: newTypes, roomSelectionsLeft: left }));

        if (left > 0) {
          const nextRoom = roomIndex + 1;
          const checkInLoop = formData.checkIn || formatDateLocal(new Date());
          const seasonLoop = getSeasonForDate(checkInLoop);
          // Count how many of each type are already chosen in this booking flow
          // (room 1 = accommodationType, rooms 2+ = extraRoomTypes so far incl. just-added)
          const chosenSoFar: Record<string, number> = {};
          const chosenKey1 = formData.accommodationType ?? "";
          if (chosenKey1) chosenSoFar[chosenKey1] = (chosenSoFar[chosenKey1] ?? 0) + 1;
          for (const t of newTypes) {
            const k = accTypeToRoomKey(t);
            chosenSoFar[k] = (chosenSoFar[k] ?? 0) + 1;
          }
          const loopAvailTypes = accTypes.filter((at) => {
            const roomKey = accTypeToRoomKey(at.type);
            if ((seasonLoop.perNight[roomKey] ?? 0) === 0) return false;
            const totalAvail = rangeRoomAvailability[roomKey] ?? 0;
            const alreadyChosen = chosenSoFar[roomKey] ?? 0;
            return totalAvail - alreadyChosen >= 1;
          });
          setCurrentStep("room_selection");
          addMessage({
            type: "bot",
            text: `You need ${totalRooms} rooms total. Selecting room ${roomIndex} of ${totalRooms} done. Which room type for room ${nextRoom} of ${totalRooms}?`,
            options: [...loopAvailTypes.map(stayRoomLabel), "← Back"],
          });
        } else {
          // All rooms configured — derive hasExtra from adults count to avoid stale closure
          const accPeopleLocal = formData.serviceType === "both" ? formData.accommodationPeople ?? 1 : formData.numberOfPeople ?? 1;
          const childrenLocal = (formData.childrenUnder5 as number) ?? 0;
          const adultsLocal = Math.max(1, accPeopleLocal - childrenLocal);
          const stillHasExtra = adultsLocal > 1 && adultsLocal % 2 !== 0;
          if (stillHasExtra) {
            askExtraBedOrRoom();
          } else {
            askArrivalTime();
          }
        }
        break;
      }

      // ─�� EXTRA BED OR EXTRA ROOM ──────────────────────────────────────────────
      case "extra_bed_choice": {
        if (input.includes("back")) {
          setCurrentStep("accommodation_type");
          const roomsNeeded = formData.numberOfRooms ?? 1;
          const checkInExtraBack = formData.checkIn || formatDateLocal(new Date());
          const seasonExtraBack = getSeasonForDate(checkInExtraBack);
          const typesWithEnough = accTypes.filter((at) => {
            const roomKey = accTypeToRoomKey(at.type);
            return (seasonExtraBack.perNight[roomKey] ?? 0) > 0 && (rangeRoomAvailability[accTypeToRoomKey(at.type)] ?? 0) >= roomsNeeded;
          });
          addMessage({
            type: "bot",
            text: "Which type of room would you like?",
            options: [
              ...typesWithEnough.map(stayRoomLabel),
              "← Choose different dates",
            ],
          });
          break;
        }
        if (input.includes("extra bed")) {
          setFormData((prev) => ({ ...prev, extraBed: true }));
          askArrivalTime();
        } else {
          // Room 1's type is already chosen (formData.accommodationType) — exclude
          // it from the count of remaining rooms, same fix as the room_selection loop.
          const checkInExtra = formData.checkIn || formatDateLocal(new Date());
          const seasonExtra = getSeasonForDate(checkInExtra);
          const room1Type = formData.accommodationType ? accTypeToRoomKey(formData.accommodationType) : null;
          const extraAvailTypes = accTypes.filter((at) => {
            const roomKey = accTypeToRoomKey(at.type);
            if ((seasonExtra.perNight[roomKey] ?? 0) <= 0) return false;
            const totalAvail = rangeRoomAvailability[roomKey] ?? 0;
            const alreadyChosen = roomKey === room1Type ? 1 : 0;
            return totalAvail - alreadyChosen >= 1;
          });
          setCurrentStep("extra_room_type");
          addMessage({
            type: "bot",
            text: "Which room type for the additional room?",
            options: [...extraAvailTypes.map(stayRoomLabel), "← Back"],
          });
        }
        break;
      }

      case "extra_room_type": {
        if (input.includes("back")) {
          askExtraBedOrRoom();
          break;
        }
        const checkInExtraSel = formData.checkIn || formatDateLocal(new Date());
        const seasonExtraSel = getSeasonForDate(checkInExtraSel);
        const room1TypeSel = formData.accommodationType ? accTypeToRoomKey(formData.accommodationType) : null;
        const validExtraTypes = accTypes.filter((at) => {
          const roomKey = accTypeToRoomKey(at.type);
          if ((seasonExtraSel.perNight[roomKey] ?? 0) <= 0) return false;
          const totalAvail = rangeRoomAvailability[roomKey] ?? 0;
          const alreadyChosen = roomKey === room1TypeSel ? 1 : 0;
          return totalAvail - alreadyChosen >= 1;
        });
        const sel = validExtraTypes.find((a) => input.includes(a.name.toLowerCase()));
        if (!sel) {
          addMessage({ type: "bot", text: "That room type isn't available. Please select one of the options shown." });
          break;
        }
        setFormData((prev) => ({ ...prev, extraRoomType: sel.type }));
        askArrivalTime();
        break;
      }

      // ── ARRIVAL TIME ─────────────────────────────────────────────────────────
      case "arrival_time": {
        if (input.includes("back")) {
          // Back to last room step
          const totalRooms = formData.numberOfRooms ?? 1;
          const checkInArrBack = formData.checkIn || formatDateLocal(new Date());
          const seasonArrBack = getSeasonForDate(checkInArrBack);
          if (totalRooms > 1) {
            setCurrentStep("room_selection");
            const validTypesArr = accTypes.filter((at) => {
              const roomKey = accTypeToRoomKey(at.type);
              return (seasonArrBack.perNight[roomKey] ?? 0) > 0 && (rangeRoomAvailability[accTypeToRoomKey(at.type)] ?? 0) >= 1;
            });
            addMessage({
              type: "bot",
              text: "Which room type would you like?",
              options: [...validTypesArr.map(stayRoomLabel), "← Back"],
            });
          } else {
            setCurrentStep("accommodation_type");
            const typesWithEnough = accTypes.filter((at) => {
              const roomKey = accTypeToRoomKey(at.type);
              return (seasonArrBack.perNight[roomKey] ?? 0) > 0 && (rangeRoomAvailability[accTypeToRoomKey(at.type)] ?? 0) >= 1;
            });
            addMessage({
              type: "bot",
              text: "Which type of room would you like?",
              options: [
                ...typesWithEnough.map(stayRoomLabel),
                "← Choose different dates",
              ],
            });
          }
          break;
        }
        setFormData((prev) => ({ ...prev, arrivalTime: userInput }));
        if (formData.serviceType === "both") {
          // Accommodation done — now surf
          setCurrentStep("surf_people");
          addMessage({
            type: "bot",
            text: "Accommodation sorted! Now for surf lessons — how many people want to join?",
            options: ["1 person", "2 people", "3 people", "4 people", "5+ people (group)", "← Back"],
          });
        } else {
          askContactName();
        }
        break;
      }

      // ── SURF + STAY PACKAGE FLOW ──────────────────────────────────────────────
      case "package_days": {
        if (input.includes("back")) {
          setCurrentStep("booking_type");
          addMessage({ type: "bot", text: "What would you like to book?", options: BOOKING_TYPES, dealOption: "Surf + Stay Package" });
          break;
        }
        const days = input.includes("3") ? 3 : input.includes("7") ? 7 : 5;
        setFormData((prev) => ({ ...prev, packageDays: days as 3 | 5 | 7 }));
        setCurrentStep("surf_people");
        addMessage({
          type: "bot",
          text: "How many people total (including any children) will be staying and surfing?",
          options: ["1 person", "2 people", "3 people", "4 people", "5+ people (group)", "← Back"],
        });
        break;
      }

      case "package_kids_under5": {
        if (input.includes("back")) {
          setCurrentStep("package_days");
          addMessage({ type: "bot", text: "Which package would you like?", options: ["3 Day Course with 3 Nights", "5 Day Course with 5 Nights", "7 Day Course with 7 Nights", "← Back"] });
          break;
        }
        const totalPpl = formData.surfPeople ?? 1;
        const m5 = input.match(/(\d+)/);
        const under5 = m5 ? parseInt(m5[1]) : 0;
        const roomOccupants = totalPpl - under5;
        setFormData((prev) => ({ ...prev, packageKidsUnder5: under5, packageRoomOccupants: roomOccupants }));
        if (calcRooms(roomOccupants).hasExtra) {
          setCurrentStep("package_extra_bed_or_room");
          addMessage({
            type: "bot",
            text: `Our rooms are for 2 people. With ${roomOccupants} people needing a room, you'll have 1 extra person — would you like an extra bed in an existing room (+1000 Rs/night) or a separate room?`,
            options: ["Extra bed (+1000 Rs/night)", "Separate room", "← Back"],
          });
        } else {
          const defaultRooms = roomOccupants <= 1 ? 1 : Math.max(1, Math.ceil(roomOccupants / 2));
          setFormData((prev) => ({ ...prev, packageRoomCount: defaultRooms }));
          setCurrentStep("date_selection");
          addMessage({ type: "bot", text: "Now pick your start date for the package." });
          loadCalendarAvailability("package");
        }
        break;
      }

      case "package_extra_bed_or_room": {
        if (input.includes("back")) {
          askKidsUnder5Question();
          break;
        }
        const roomOccupants = formData.packageRoomOccupants ?? 1;
        if (input.includes("extra bed")) {
          const rooms = Math.max(1, Math.floor(roomOccupants / 2));
          setFormData((prev) => ({ ...prev, packageWantsExtraBed: true, packageRoomCount: rooms }));
          setCurrentStep("date_selection");
          addMessage({ type: "bot", text: "Now pick your start date for the package." });
          loadCalendarAvailability("package");
        } else {
          const rooms = Math.max(1, Math.ceil(roomOccupants / 2));
          setFormData((prev) => ({ ...prev, packageWantsExtraBed: false, packageRoomCount: rooms }));
          setCurrentStep("date_selection");
          addMessage({ type: "bot", text: "Now pick your start date for the package." });
          loadCalendarAvailability("package");
        }
        break;
      }

      case "package_room_type": {
        const roomsCount = formData.packageRoomCount ?? 1;
        const currentIndex = formData.packageRoomTypeIndex ?? 0;

        if (input.includes("back")) {
          if (currentIndex > 0) {
            // Go back to previous room's question, removing its saved type
            const prevTypes = (formData.packageRoomTypes ?? []).slice(0, currentIndex - 1);
            setFormData((prev) => ({ ...prev, packageRoomTypes: prevTypes }));
            askPackageRoomType(formData.date, currentIndex - 1, roomsCount);
          } else {
            setFormData((prev) => ({ ...prev, packageRoomTypes: [] }));
            setCurrentStep("date_selection");
            addMessage({ type: "bot", text: "Pick your start date for the package." });
            loadCalendarAvailability("package");
          }
          break;
        }

        // Match room type from button label — order matters (premium_fan before fan, premium_ac before ac)
        let roomType: RoomKeyType = "fan";
        if (input.includes("premium fan"))      roomType = "premium_fan";
        else if (input.includes("premium ac"))  roomType = "premium_ac";
        else if (input.includes("premium"))     roomType = "premium_ac"; // fallback
        else if (input.includes("ac"))          roomType = "ac";

        const updatedTypes = [...(formData.packageRoomTypes ?? [])];
        updatedTypes[currentIndex] = roomType;
        setFormData((prev) => ({ ...prev, packageRoomTypes: updatedTypes, packageRoomType: roomType }));

        const nextIndex = currentIndex + 1;
        if (nextIndex < roomsCount) {
          // Pass updatedTypes explicitly — formData.packageRoomTypes update is async
          // so the stale closure would not yet include the room just selected.
          askPackageRoomType(formData.date, nextIndex, roomsCount, updatedTypes as RoomKey[]);
          break;
        }

        // All rooms chosen — show price confirmation now that we know room types + date (season)
        const { season: chosenSeason, roomTotal } = calcPackagePrice({ ...formData, packageRoomTypes: updatedTypes });
        const roomSummary = updatedTypes.map((t) => ROOM_LABELS[t]).join(", ");
        addMessage({
          type: "bot",
          text: `Rooms (${chosenSeason.label}): ${roomSummary} — ${roomTotal.toLocaleString()} Rs total${formData.packageWantsExtraBed ? " (incl. extra bed)" : ""}`,
        });

        // Now determine who in the group actually wants to surf (organizer always does;
        // ask about the rest), then continue into kids-lesson / swimmer surcharge logic.
        askPackageSurfParticipation(formData.surfPeople);
        break;
      }

      case "surf_people": {
        if (input.includes("back")) {
          setCurrentStep("package_days");
          addMessage({ type: "bot", text: "Which package would you like?", options: ["3 Day Course with 3 Nights", "5 Day Course with 5 Nights", "7 Day Course with 7 Nights", "← Back"] });
          break;
        }
        const m = input.match(/(\d+)/);
        const n = m ? parseInt(m[1]) : 1;
        if (n >= 5) {
          setFormData((prev) => ({ ...prev, surfPeople: n }));
          setCurrentStep("large_surf_people");
          addMessage({
            type: "bot",
            text: "How many people exactly?",
            options: ["5", "6", "7", "8", "9", "10", "11", "12", "← Back"],
          });
        } else if (n === 1) {
          // Solo traveler: no children question, no extra-bed question — 1 room, no extra person.
          const defaultRooms = 1;
          setFormData((prev) => ({ ...prev, surfPeople: 1, packageKidsUnder5: 0, packageRoomOccupants: 1, packageRoomCount: defaultRooms }));
          setCurrentStep("date_selection");
          addMessage({ type: "bot", text: "Now pick your start date for the package." });
          loadCalendarAvailability("package");
        } else {
          setFormData((prev) => ({ ...prev, surfPeople: n }));
          askKidsUnder5Question(n);
        }
        break;
      }

      case "large_surf_people": {
        if (input.includes("back")) {
          setCurrentStep("surf_people");
          addMessage({
            type: "bot",
            text: "How many people total?",
            options: ["1 person", "2 people", "3 people", "4 people", "5+ people (group)", "← Back"],
          });
          break;
        }
        const m = input.match(/(\d+)/);
        const n = m ? parseInt(m[1]) : 5;
        setFormData((prev) => ({ ...prev, surfPeople: n }));
        askKidsUnder5Question(n);
        break;
      }

      // ── KIDS COUNT (surf) ────────────────────────────────────────────────────
      // ── SURF PARTICIPATION (Surf+Stay only) ─────────────────────────────────
      // Determines how many of the group actually surf — not everyone booking a
      // Surf+Stay package necessarily wants to surf themselves.
      case "package_surf_participation": {
        const totalPpl = formData.surfPeople ?? 1;
        const includedFree = Math.min(formData.packageRoomCount ?? 1, totalPpl);
        const others = totalPpl - includedFree; // everyone beyond the included-free surfers (under-5 status doesn't exclude anyone here)

        if (input.includes("back")) {
          const roomsCount = formData.packageRoomCount ?? 1;
          askPackageRoomType(formData.date, roomsCount - 1, roomsCount);
          break;
        }

        let surfingCount: number;
        if (others === 1) {
          // Yes/No wording
          surfingCount = input.includes("yes") ? includedFree + 1 : includedFree;
        } else {
          const m = input.match(/(\d+)/);
          const additionalChosen = m ? Math.min(others, parseInt(m[1])) : 0;
          surfingCount = includedFree + additionalChosen;
        }

        setFormData((prev) => ({ ...prev, packageSurfingCount: surfingCount }));
        proceedAfterSurfParticipation(surfingCount);
        break;
      }

      case "kids_count": {
        const isPkg = formData.serviceType === "both";
        // Package flow: this question is scoped to "additional surfers" — everyone
        // beyond the included-free surfers (1 per room/package booked).
        // Surf-only flow: this question is scoped to the full group.
        const additionalSurfers = Math.max(0, (formData.packageSurfingCount ?? 1) - (formData.packageRoomCount ?? 1));
        const total = isPkg ? additionalSurfers : formData.numberOfPeople ?? 1;

        if (input.includes("back")) {
          if (isPkg) {
            askPackageSurfParticipation(formData.surfPeople);
          } else if (total >= 5) {
            setCurrentStep("large_group_size");
            addMessage({ type: "bot", text: "How many people exactly?", options: ["5","6","7","8","9","10","11","12","← Back"] });
          } else {
            askGroupSize("How many people are joining the surf lesson?");
          }
          break;
        }
        const mKids = input.match(/(\d+)/);
        const kids = isPkg && total === 1
          ? (input.includes("yes") ? 1 : 0) // "Is that additional surfer a child?" Yes/No
          : (mKids ? parseInt(mKids[1]) : 0);
        setFormData((prev) => ({ ...prev, numberOfKids: kids }));
        const nonKids = total - kids;

        if (isPkg) {
          // Ask swimmer count across ALL surfing adults (organizer + non-kid additional surfers)
          const adultsToAsk = (formData.packageRoomCount ?? 1) + nonKids;
          askPackageSwimmersCount(adultsToAsk);
          break;
        }

        if (nonKids > 0) {
          if (nonKids === 1) {
            // Only 1 adult — ask directly if swimmer
            askSwimmer(nonKids);
          } else {
            // Multiple adults — skip yes/no, ask non-swimmer count directly
            setCurrentStep("non_swimmer_count");
            addMessage({
              type: "bot",
              text: `How many of the ${nonKids} adult${nonKids > 1 ? "s" : ""} are non-swimmers?`,
              options: [...Array.from({ length: nonKids + 1 }, (_, i) => String(i)), "← Back"],
            });
          }
        } else {
          // All are kids — no swimmer question needed, go straight to course (kids only)
          setFormData((prev) => ({ ...prev, isSwimmer: false, numberOfNonSwimmers: 0 }));
          setCurrentStep("surfed_before");
          addMessage({ type: "bot", text: "Have any of the kids surfed before?", options: ["Yes", "No", "← Back"] });
        }
        break;
      }

      // ── PACKAGE SWIMMER COUNT ────────────────────────────────────────────────
      // Counts swimmers across ALL surfing adults (incl. the organizer whose
      // course is part of the package). Kids are excluded — they take the Kids
      // course regardless of swimming ability.
      case "package_swimmer_count": {
        const additionalSurfersPSC = Math.max(0, (formData.packageSurfingCount ?? 1) - (formData.packageRoomCount ?? 1));
        const kidsAmongAdditionalPSC = formData.numberOfKids ?? 0;
        const adultsPSC = (formData.packageRoomCount ?? 1) + Math.max(0, additionalSurfersPSC - kidsAmongAdditionalPSC);

        if (input.includes("back")) {
          if (additionalSurfersPSC > 0) {
            askPackageSurfKidsCount(additionalSurfersPSC);
          } else {
            askPackageSurfParticipation(formData.surfPeople);
          }
          break;
        }

        let swimmersPSC: number;
        if (adultsPSC <= 1) {
          swimmersPSC = input.includes("yes") ? 1 : 0;
        } else {
          const m = input.match(/(\d+)/);
          swimmersPSC = m ? Math.min(adultsPSC, parseInt(m[1])) : 0;
        }
        const nonSwimmersPSC = adultsPSC - swimmersPSC;
        setFormData((prev) => ({ ...prev, numberOfNonSwimmers: nonSwimmersPSC, isSwimmer: swimmersPSC > 0 }));

        if (swimmersPSC === 0) {
          // Nobody can swim — booking still completes normally (package for the
          // organizer, Private Lessons for the others), but they must contact
          // us on WhatsApp so we can arrange the details safely.
          addMessage({
            type: "bot",
            text: "Since none of the surfers can swim, all lessons will be Private Lessons for safety. Please contact us on WhatsApp after booking so we can arrange the details. Your reservation will still be completed normally.",
          });
        }

        setCurrentStep("surfed_before");
        addMessage({ type: "bot", text: swimmersPSC === 0 ? "Have you surfed before?" : "Great! Have you surfed before?", options: ["Yes", "No", "← Back"] });
        break;
      }

      // ── SWIMMER CHECK (surf-only flow) ────────────────────────────────────────
      // NOTE: Surf+Stay packages use the separate "package_swimmer_count" step/case
      // instead (askPackageSwimmersCount) — this step is never entered from the
      // package flow.
      case "swimming_ability": {
        if (input.includes("back")) {
          const total = formData.numberOfPeople ?? 1;
          if (total > 1) {
            askKidsCount(total);
          } else {
            askGroupSize("How many people are joining the surf lesson?");
          }
          break;
        }

        const total = formData.numberOfPeople ?? 1;
        const nonKidsTotal = total - (formData.numberOfKids ?? 0);

        if (input.includes("yes")) {
          setFormData((prev) => ({ ...prev, isSwimmer: true, numberOfNonSwimmers: 0 }));
          setCurrentStep("surfed_before");
          addMessage({ type: "bot", text: "Awesome! Have you surfed before?", options: ["Yes", "No", "← Back"] });
        } else {
          if (nonKidsTotal > 1) {
            setCurrentStep("non_swimmer_count");
            addMessage({
              type: "bot",
              text: `Out of ${nonKidsTotal} (non-kids) people, how many are non-swimmers?`,
              options: [...Array.from({ length: nonKidsTotal }, (_, i) => String(i + 1)), "← Back"],
            });
          } else {
            setFormData((prev) => ({ ...prev, isSwimmer: false, numberOfNonSwimmers: 1 }));
            setCurrentStep("surfed_before");
            addMessage({ type: "bot", text: "No problem! Have you surfed before?", options: ["Yes", "No", "← Back"] });
          }
        }
        break;
      }

      // ── NON-SWIMMER COUNT (surf-only flow) ───────────────────────────────────
      // NOTE: package flow never enters this step — see comment above.
      case "non_swimmer_count": {
        if (input.includes("back")) {
          const total = formData.numberOfPeople ?? 1;
          const kids = formData.numberOfKids ?? 0;
          const nonKids = total - kids;
          if (kids > 0 && nonKids > 1) {
            askKidsCount(total);
          } else {
            askSwimmer(nonKids > 0 ? nonKids : total);
          }
          break;
        }
        const count = parseInt(userInput, 10);
        if (isNaN(count) || count < 0) {
          addMessage({ type: "bot", text: "Please select how many people are non-swimmers." });
          break;
        }
        const nonKidsCount = (formData.numberOfPeople ?? 1) - (formData.numberOfKids ?? 0);
        const swimmers = nonKidsCount - count;
        setFormData((prev) => ({ ...prev, numberOfNonSwimmers: count, isSwimmer: swimmers > 0 }));

        if (swimmers > 0) {
          setCurrentStep("surfed_before");
          addMessage({
            type: "bot",
            text: `Got it — ${count} non-swimmer${count > 1 ? "s" : ""} (Private Lesson) and ${swimmers} swimmer${swimmers > 1 ? "s" : ""}. Have you surfed before?`,
            options: ["Yes", "No", "← Back"],
          });
        } else {
          setCurrentStep("surfed_before");
          addMessage({ type: "bot", text: "No problem! Have you surfed before?", options: ["Yes", "No", "← Back"] });
        }
        break;
      }

      // ── SURF EXPERIENCE ──────────────────────────────────────────────────────
      case "surfed_before": {
        const isPkgSB = formData.serviceType === "both";
        const additionalSurfersSB = Math.max(0, (formData.packageSurfingCount ?? 1) - (formData.packageRoomCount ?? 1));
        const kidsAmongAdditionalSB = formData.numberOfKids ?? 0;
        const adultsToAskSB = (formData.packageRoomCount ?? 1) + Math.max(0, additionalSurfersSB - kidsAmongAdditionalSB);

        if (input.includes("back")) {
          if (isPkgSB) {
            askPackageSwimmersCount(adultsToAskSB);
          } else {
            const total = formData.numberOfPeople ?? 1;
            const kids = formData.numberOfKids ?? 0;
            const nonKids = total - kids;
            if (nonKids > 1 && (formData.numberOfNonSwimmers ?? 0) > 0) {
              setCurrentStep("non_swimmer_count");
              addMessage({ type: "bot", text: `Out of ${nonKids} people, how many are non-swimmers?`, options: [...Array.from({ length: nonKids }, (_, i) => String(i + 1)), "← Back"] });
            } else if (nonKids > 0) {
              askSwimmer(nonKids);
            } else {
              askKidsCount(total);
            }
          }
          break;
        }
        if (input.includes("yes")) {
          setFormData((prev) => ({ ...prev, surfedBefore: true }));
          setCurrentStep("surf_school");
          addMessage({ type: "bot", text: "Was it with SurfWala?", options: ["Yes", "No", "← Back"] });
        } else {
          setFormData((prev) => ({ ...prev, surfedBefore: false }));
          // FIX 2: read nonSwimmers from formData at time of call (not closure)
          const snapIsSwimmer = formData.isSwimmer;
          const snapNonSwim = formData.numberOfNonSwimmers ?? 0;
          const snapTotAll = formData.serviceType === "both" ? formData.packageSurfingCount ?? formData.surfPeople ?? 1 : formData.numberOfPeople ?? 1;
          const snapTot = snapTotAll - (formData.numberOfKids ?? 0);
          askCourse(snapIsSwimmer, snapNonSwim, snapTot > 0 ? snapTot : snapTotAll);
        }
        break;
      }

      case "surf_school": {
        if (input.includes("back")) {
          setCurrentStep("surfed_before");
          addMessage({ type: "bot", text: "Have you surfed before?", options: ["Yes", "No", "← Back"] });
          break;
        }
        if (input.includes("yes")) {
          setFormData((prev) => ({ ...prev, surfSchool: "SurfWala" }));
          setCurrentStep("sessions_count");
          addMessage({ type: "bot", text: "How many sessions have you completed?", options: ["1-2 sessions", "3+ sessions", "← Back"] });
        } else {
          setFormData((prev) => ({ ...prev, surfSchool: "Other" }));
          setCurrentStep("surf_location");
          addMessage({ type: "bot", text: "Where did you take your surf course?" });
        }
        break;
      }

      case "surf_location":
        if (input.includes("back")) {
          setCurrentStep("surf_school");
          addMessage({ type: "bot", text: "Was it with SurfWala?", options: ["Yes", "No", "← Back"] });
          break;
        }
        setFormData((prev) => ({ ...prev, surfLocation: userInput }));
        setCurrentStep("sessions_count");
        addMessage({ type: "bot", text: "How many sessions have you completed?", options: ["1-2 sessions", "3+ sessions", "← Back"] });
        break;

      case "sessions_count": {
        if (input.includes("back")) {
          if (formData.surfSchool === "Other") {
            setCurrentStep("surf_location");
            addMessage({ type: "bot", text: "Where did you take your surf course?" });
          } else {
            setCurrentStep("surf_school");
            addMessage({ type: "bot", text: "Was it with SurfWala?", options: ["Yes", "No", "← Back"] });
          }
          break;
        }
        setFormData((prev) => ({ ...prev, sessionsCount: userInput }));
        // FIX 2: explicit snapshot to avoid stale closure
        const snapIsSwimmer2 = formData.isSwimmer;
        const snapNonSwim2 = formData.numberOfNonSwimmers ?? 0;
        const snapTotAll2 = formData.serviceType === "both" ? formData.packageSurfingCount ?? formData.surfPeople ?? 1 : formData.numberOfPeople ?? 1;
        const snapTot2 = snapTotAll2 - (formData.numberOfKids ?? 0);
        askCourse(snapIsSwimmer2, snapNonSwim2, snapTot2 > 0 ? snapTot2 : snapTotAll2);
        break;
      }

      // ── COURSE SELECTION ─────────────────────────────────────────────────────
      case "course_type": {
        if (input.includes("back")) {
          const snap = formData.isSwimmer;
          const nonSwim = formData.numberOfNonSwimmers ?? 0;
          const totAll = formData.serviceType === "both" ? formData.packageSurfingCount ?? formData.surfPeople ?? 1 : formData.numberOfPeople ?? 1;
          const tot = totAll - (formData.numberOfKids ?? 0);
          askCourse(snap, nonSwim, tot > 0 ? tot : totAll);
          break;
        }
        const sel = courses.find((c) => input.includes(c.name.toLowerCase()));
        if (sel) setFormData((prev) => ({ ...prev, courseType: sel.type }));
        setCurrentStep("date_selection");
        addMessage({ type: "bot", text: "Pick a date for your surf lesson. Fully booked days are shown in red." });
        loadCalendarAvailability("surf");
        break;
      }

      // ── TIME SELECTION ───────────────────────────────────────────────────────
      case "time_selection": {
        if (input.includes("back")) {
          setCurrentStep("date_selection");
          addMessage({ type: "bot", text: "Pick a date for your surf lesson.", });
          loadCalendarAvailability("surf");
          break;
        }
        const selTime = TIME_SLOTS.find((t) => input.includes(t));
        const time = selTime || DEFAULT_TIME;
        setFormData((prev) => ({ ...prev, time }));
        addMessage({ type: "bot", text: `Perfect! Surf lesson on ${formData.date} at ${time}.` });
        askContactName();
        break;
      }

      // ── CONTACT ──────────────────────────────────────────────────────────────
      case "contact_name":
        if (input.includes("back")) {
          if (formData.serviceType === "accommodation") {
            askArrivalTime();
          } else if (formData.serviceType === "both") {
            // Package flow: back to surfed_before (last step before contact)
            setCurrentStep("surfed_before");
            addMessage({ type: "bot", text: "Have you surfed before?", options: ["Yes", "No", "← Back"] });
          } else {
            const isPrivate = formData.courseType === "private";
            const allNonSwim = (formData.numberOfNonSwimmers ?? 0) === (formData.numberOfPeople ?? 1);
            if (isPrivate || allNonSwim) {
              setCurrentStep("date_selection");
              addMessage({ type: "bot", text: "Pick a date for your surf lesson." });
              loadCalendarAvailability("surf");
            } else {
              setCurrentStep("time_selection");
              addMessage({ type: "bot", text: "Which time slot works for you?", options: [...TIME_SLOTS.map((t) => t), "← Back"] });
            }
          }
          break;
        }
        setFormData((prev) => ({ ...prev, name: userInput }));
        setCurrentStep("contact_phone");
        addMessage({ type: "bot", text: `Thanks ${userInput}! What's your phone number?`, options: ["← Back"] });
        break;

      case "contact_phone":
        if (input.includes("back")) {
          setCurrentStep("contact_name");
          addMessage({ type: "bot", text: "What's your first and last name for the booking?", options: ["← Back"] });
          break;
        }
        setFormData((prev) => ({ ...prev, phone: userInput }));
        setCurrentStep("contact_email");
        addMessage({ type: "bot", text: "And your email address? (Required - we'll send your confirmation here)", options: ["← Back"] });
        break;

      case "contact_email": {
        if (input.includes("back")) {
          setCurrentStep("contact_phone");
          addMessage({ type: "bot", text: "What's your phone number?", options: ["← Back"] });
          break;
        }
        if (!isValidEmail(userInput)) {
          addMessage({ type: "bot", text: "Please enter a valid email." });
          return;
        }
        setFormData((prev) => ({ ...prev, email: userInput }));
        setCurrentStep("contact_preference");
        addMessage({ type: "bot", text: "What is your preferred contact method?", options: ["WhatsApp", "Phone call", "Email"] });
        break;
      }

      case "contact_preference": {
        if (input.includes("back")) {
          setCurrentStep("contact_email");
          addMessage({ type: "bot", text: "And your email address?", options: ["← Back"] });
          break;
        }
        let pref: "WhatsApp" | "Phone call" | "Email" = "Email";
        if (input.includes("whatsapp")) pref = "WhatsApp";
        else if (input.includes("phone")) pref = "Phone call";
        const updated = { ...formData, contactPreference: pref };
        setFormData(updated);
        setCurrentStep("confirmation");
        addMessage({ type: "bot", text: buildSummary(updated), options: ["Confirm Booking", "Cancel"] });
        break;
      }

      case "confirmation":
        if (input.includes("confirm")) submitReservation(formData);
        else if (input.includes("cancel") || input.includes("start over")) resetChat();
        else if (input.includes("try again")) {
          // Server rejected the booking (e.g. overbooking) — go back to room selection
          // so the customer can pick a different room type or dates.
          const isPkg = formData.serviceType === "both";
          if (isPkg && formData.date) {
            // Package flow uses formData.date (+ packageDays), never checkIn/checkOut.
            // Reset room selections and re-run availability check for this date.
            setFormData((prev) => ({ ...prev, packageRoomTypes: [], packageRoomTypeIndex: 0 }));
            askPackageRoomType(formData.date, 0, formData.packageRoomCount ?? 1, []);
          } else if (formData.checkIn && formData.checkOut) {
            const accPeople = formData.numberOfPeople ?? 1;
            const roomsNeeded = formData.numberOfRooms ?? Math.max(1, Math.ceil(accPeople / 2));
            checkRangeAvailabilityAndShowRooms(formData.checkIn, formData.checkOut, roomsNeeded);
          } else {
            submitReservation(formData); // surf-only: just retry submit
          }
        }
        break;

      // ── CALENDAR BACK (check_in_date / check_out_date) ─────────────────────────
      // These steps render a calendar (not text options), so "back" can only be
      // triggered via the Back button rendered inside the calendar UI itself.
      case "check_in_date": {
        if (input.includes("back")) {
          if (formData.serviceType === "both") {
            const accP = formData.accommodationPeople ?? 1;
            if (accP > 1) {
              askChildrenUnder5(accP, "accommodation_people");
            } else if (accP >= 5) {
              setCurrentStep("large_acc_people");
              addMessage({ type: "bot", text: "How many people exactly need accommodation?", options: ["5","6","7","8","9","10","11","12","← Back"] });
            } else {
              setCurrentStep("accommodation_people");
              addMessage({ type: "bot", text: "How many people need accommodation?", options: ["1 person","2 people","3 people","4 people","5+ people (group)","← Back"] });
            }
          } else {
            const accP = formData.numberOfPeople ?? 1;
            if (accP > 1) {
              askChildrenUnder5(accP, "group_size");
            } else if (accP >= 5) {
              setCurrentStep("large_group_size");
              addMessage({ type: "bot", text: "How many people exactly?", options: ["5","6","7","8","9","10","11","12","← Back"] });
            } else {
              askGroupSize("How many people need accommodation?");
            }
          }
        }
        break;
      }

      case "check_out_date": {
        if (input.includes("back")) {
          setCurrentStep("check_in_date");
          addMessage({ type: "bot", text: "Pick your check-in date." });
          loadCalendarAvailability("room");
        }
        break;
      }

      // ── CALENDAR BACK (date_selection — surf or package) ────────────────────────
      case "date_selection": {
        if (input.includes("back")) {
          if (formData.serviceType === "both") {
            const roomOccupants = formData.packageRoomOccupants ?? 1;
            if (roomOccupants % 2 !== 0 && roomOccupants > 0) {
              setCurrentStep("package_extra_bed_or_room");
              addMessage({
                type: "bot",
                text: `Our rooms are for 2 people. With ${roomOccupants} people needing a room, you'll have 1 extra person — would you like an extra bed in an existing room (+1000 Rs/night) or a separate room?`,
                options: ["Extra bed (+1000 Rs/night)", "Separate room", "← Back"],
              });
            } else {
              askKidsUnder5Question();
            }
          } else {
            const isPrivate = formData.courseType === "private";
            const total = formData.numberOfPeople ?? 1;
            const nonSwim = formData.numberOfNonSwimmers ?? 0;
            const nonKids = total - (formData.numberOfKids ?? 0);
            if (isPrivate) {
              setCurrentStep("course_type");
              addMessage({
                type: "bot",
                text: "Since none of you are swimmers yet, we can only offer a Private Lesson for your safety.",
                options: [...courses.filter((c) => c.type === "private").map(formatCourseOption), "← Back"],
              });
            } else {
              askCourse(formData.isSwimmer, nonSwim, nonKids > 0 ? nonKids : total);
            }
          }
        }
        break;
      }

      default:
        addMessage({ type: "bot", text: "I didn't quite get that. Could you try again?" });
    }
  };

  const handleSend = () => {
    if (!inputValue.trim() || isSubmitting) return;
    addMessage({ type: "user", text: inputValue });
    const value = inputValue;
    setInputValue("");
    setTimeout(() => processResponse(value), 400);
  };

  const effectiveMonthOffset = currentStep === "date_selection" ? Math.max(monthOffset, minSurfMonthOffset()) : monthOffset;
  const calendarDates = getCalendarDates(effectiveMonthOffset);
  const isCalendarStep = currentStep === "date_selection" || currentStep === "check_in_date" || currentStep === "check_out_date";
  const calendarMode = currentStep === "date_selection"
    ? (formData.serviceType === "both" ? "package" : "surf")
    : "room";
  const firstCalendarOffset = currentStep === "date_selection" ? minSurfMonthOffset() : 0;

  if (!isVisible) return null;

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader className="border-b bg-white">
        <div className="flex flex-col items-center text-center py-1">
          <CardTitle className="text-blue-600 text-lg font-bold">Surf Wala</CardTitle>
          <p className="text-blue-400 text-sm">booking system</p>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="h-96 space-y-4 overflow-y-auto bg-gray-50 p-4">
          {messages.map((message, msgIdx) => {
            const isLastMessage = msgIdx === messages.length - 1;
            const buttonsActive = isLastMessage && !isSubmitting;
            return (
            <div key={message.id} className={`flex ${message.type === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-2 ${message.type === "user" ? "bg-blue-600 text-white" : "bg-white text-blue-700 shadow-sm border border-gray-200"}`}>
                <p className="whitespace-pre-line text-sm">{message.text}</p>
                {message.options && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {message.options.map((option) => {
                      const isDeal = message.dealOption === option;
                      return isDeal ? (
                        <button key={option} disabled={!buttonsActive} onClick={() => { if (buttonsActive) handleOptionClick(option); }}
                          className={`relative h-auto whitespace-normal py-2 px-4 text-xs font-semibold rounded-lg border-2 shadow-md transition-all ${buttonsActive ? "bg-gradient-to-r from-blue-600 to-blue-500 text-white border-blue-400 hover:from-blue-700 hover:to-blue-600" : "bg-blue-300 text-white border-blue-200 cursor-not-allowed"}`}>
                          <span className="absolute -top-2.5 -right-1 bg-yellow-400 text-black text-[9px] font-black px-1.5 py-0.5 rounded-full leading-none shadow">DEAL</span>
                          🌊 {option}
                        </button>
                      ) : (
                        <Button key={option} size="sm" disabled={!buttonsActive} className={`h-auto whitespace-normal py-2 px-4 text-xs font-medium shadow-sm border ${buttonsActive ? "bg-white text-blue-600 border-blue-300 hover:bg-blue-50" : "bg-white/60 text-blue-400 border-blue-200 cursor-not-allowed"}`} onClick={() => { if (buttonsActive) handleOptionClick(option); }}>
                          {option}
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            );
          })}
          <div ref={messagesEndRef} />
          {isSubmitting && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-white shadow-sm border border-gray-200 px-4 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-sm text-gray-700">Creating your reservation...</span>
              </div>
            </div>
          )}
        </div>

        {isCalendarStep ? (
          <div className="border-t p-4">
            {isLoadingCalendar ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading availability...
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <Button variant="ghost" size="sm" onClick={() => {
                      const nextOffset = Math.max(firstCalendarOffset, monthOffset - 1);
                      setMonthOffset(nextOffset);
                      if (nextOffset !== monthOffset) loadCalendarAvailability(calendarMode, undefined, nextOffset);
                    }} disabled={monthOffset === (currentStep === "date_selection" ? minSurfMonthOffset() : 0)} className="h-8 w-8 p-0">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <h3 className="text-sm font-semibold">
                    {calendarDates.length > 0 ? getMonthLabel(calendarDates[0]) : getMonthLabelFromOffset(effectiveMonthOffset)}
                  </h3>
                  <Button variant="ghost" size="sm" onClick={() => {
                    const nextOffset = Math.min(11, monthOffset + 1);
                    setMonthOffset(nextOffset);
                    if (nextOffset !== monthOffset) loadCalendarAvailability(calendarMode, undefined, nextOffset);
                  }} disabled={monthOffset >= 11} className="h-8 w-8 p-0">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {calendarDates.map((date) => {
                    const info = availabilityMap[date];
                    const remaining = info?.remainingCapacity ?? 20;
                    // Range-aware blocking: a start date whose full course/package
                    // duration touches monsoon or blackout is shown red too.
                    const cdMap: Record<string, number> = { week: 7, immerse: 5, plunge: 3 };
                    const durDays = formData.serviceType === "both" ? (formData.packageDays ?? 3) : (cdMap[formData.courseType ?? ""] ?? 1);
                    const rangeBlocked = currentStep === "date_selection" && (
                      rangeTouchesSurfBlockedMonth(date, durDays) ||
                      (formData.serviceType === "both" && rangeTouchesBlackout(date, durDays))
                    );
                    // A date without a completed availability response is unknown;
                    // never show unknown inventory as green or selectable.
                    let isFull = rangeBlocked || !info || !info.available;
                    if (currentStep === "check_out_date" && formData.checkIn && date <= formData.checkIn) isFull = true;
                    const isLow = !isFull && remaining <= 3;
                    const isCheckIn = currentStep === "check_out_date" && date === formData.checkIn;
                    const isToday = date === getTodayDate();
                    const day = new Date(date + "T00:00:00").getDate();
                    let cls = "flex h-11 flex-col items-center justify-center rounded-md border text-sm leading-none transition-colors ";
                    if (isCheckIn) cls += "border-primary bg-primary font-bold text-primary-foreground";
                    else if (isFull) cls += "cursor-not-allowed border-destructive/40 bg-destructive/10 text-destructive line-through";
                    else if (isToday) cls += "border-blue-500 ring-2 ring-blue-500 ring-offset-1 bg-blue-50 font-bold text-blue-700 hover:bg-blue-100";
                    else if (isLow) cls += "border-orange-400 bg-orange-50 font-bold text-orange-600 hover:bg-orange-100";
                    else cls += "border-green-300 bg-green-50 text-green-700 hover:bg-green-100";
                    return (
                      <button
                        key={date}
                        type="button"
                        disabled={isFull}
                        aria-label={`${date}: ${isFull ? "fully booked" : `${remaining} remaining`}`}
                        title={isFull ? "Fully booked" : `${remaining} remaining`}
                        onClick={() => handleSelectDate(date)}
                        className={cls}
                      >
                        <span>{day}</span>
                        <span className="mt-1 text-[9px] font-medium leading-none">{isFull ? "Full" : `${remaining} left`}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-blue-500 bg-blue-50" /> Today</span>
                  <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-green-300 bg-green-50" /> Available</span>
                  <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-orange-400 bg-orange-50" /><span className="font-medium text-orange-600">Few left</span></span>
                  <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-destructive/40 bg-destructive/10" /> Booked</span>
                </div>
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isSubmitting}
                    onClick={() => { addMessage({ type: "user", text: "← Back" }); setTimeout(() => processResponse("back"), 200); }}
                    className="text-blue-600 border-blue-300 hover:bg-blue-50"
                  >
                    ← Back
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex gap-2 border-t p-4">
            <Input placeholder="Type a message..." value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSend()} disabled={isSubmitting} />
            <Button size="icon" onClick={handleSend} disabled={isSubmitting} className="bg-blue-600 hover:bg-blue-700 text-white">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
