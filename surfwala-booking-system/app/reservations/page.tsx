"use client";

import { useState } from "react";
import useSWR from "swr";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, X, Eye, Search, Filter, Pencil } from "lucide-react";
import type { Reservation } from "@/lib/types";
import { calcStayPrice } from "@/lib/pricing";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json();
  // If the API returns an error object, return empty array
  if (data?.error || !Array.isArray(data)) {
    return [];
  }
  return data;
};

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-200",
  confirmed: "bg-green-100 text-green-800 border-green-200",
  cancelled: "bg-red-100 text-red-800 border-red-200",
  completed: "bg-blue-100 text-blue-800 border-blue-200",
};

// Display names for unified room keys (and legacy DB keys, pre-migration safety)
const ROOM_TYPE_DISPLAY: Record<string, string> = {
  fan: "Fan Room",
  ac: "AC Room",
  premium_fan: "Premium Fan Room",
  premium_ac: "Premium AC Room",
  standard: "Fan Room",
  superior: "AC Room",
  premium: "Premium AC Room",
};
const roomLabel = (t: string | null) => (t ? ROOM_TYPE_DISPLAY[t] ?? `${t} Room` : "-");

// Surf records created by Surf+Stay packages may have course_id = null (course
// lookup can fail) — derive a readable label from course_type or duration.
const COURSE_TYPE_LABEL: Record<string, string> = {
  teaser: "1 Day Course", plunge: "3 Day Course", immerse: "5 Day Course",
  week: "7 Day Course", kids: "Kids Lesson", private: "Private Lesson",
};
function surfLabel(r: Reservation): string {
  if (r.course?.name) return r.course.name;
  if (r.course_type && COURSE_TYPE_LABEL[r.course_type]) return COURSE_TYPE_LABEL[r.course_type];
  if (r.course_date && r.surf_end_date && r.surf_end_date !== r.course_date) {
    const start = new Date(r.course_date + "T00:00:00");
    const end = new Date(r.surf_end_date + "T00:00:00");
    const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    return `${days} Day Course`;
  }
  return "Surf Lesson";
}

const EDITABLE_ROOM_TYPES = ["fan", "ac", "premium_fan", "premium_ac"] as const;

interface EditForm {
  check_in: string; check_out: string; accommodation_type: string;
  course_date: string; course_time: string;
  number_of_people: number; total_price: number; special_requests: string;
}

export default function ReservationsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedReservation, setSelectedReservation] =
    useState<Reservation | null>(null);

  // ── Edit modal state ────────────────────────────────────────────────────
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    check_in: "", check_out: "", accommodation_type: "",
    course_date: "", course_time: "", number_of_people: 1,
    total_price: 0, special_requests: "",
  });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = (r: Reservation) => {
    setEditError(null);
    setEditing(r);
    setEditForm({
      check_in: r.check_in ?? "",
      check_out: r.check_out ?? "",
      accommodation_type: r.accommodation_type ?? "",
      course_date: r.course_date ?? "",
      course_time: r.course_time ?? "",
      number_of_people: r.number_of_people ?? 1,
      total_price: r.total_price ?? 0,
      special_requests: r.special_requests ?? "",
    });
  };

  const editIsAccommodation = editing ? Boolean(editing.check_in || editing.accommodation_type) : false;
  const editIsSurf = editing ? Boolean(editing.course_date) : false;

  // Recalculate seasonal price (per-night, season-aware) for current form
  // values; admin can still override the number manually (agreed discount).
  const recalcPrice = () => {
    if (!editIsAccommodation || !editForm.check_in || !editForm.check_out || !editForm.accommodation_type) return;
    const result = calcStayPrice(editForm.accommodation_type, editForm.check_in, editForm.check_out);
    setEditForm((f) => ({ ...f, total_price: result.total }));
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    setEditError(null);
    try {
      const payload: Record<string, unknown> = {
        number_of_people: editForm.number_of_people,
        total_price: editForm.total_price,
        special_requests: editForm.special_requests || null,
      };
      if (editIsAccommodation) {
        payload.check_in = editForm.check_in || null;
        payload.check_out = editForm.check_out || null;
        payload.accommodation_type = editForm.accommodation_type || null;
      }
      if (editIsSurf) {
        payload.course_date = editForm.course_date || null;
        payload.course_time = editForm.course_time || null;
      }
      const res = await fetch(`/api/reservations/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setEditError(err.error || `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      setEditing(null);
      mutate();
    } catch {
      setEditError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  };

  const queryParams = new URLSearchParams();
  if (statusFilter !== "all") {
    queryParams.set("status", statusFilter);
  }

  const {
    data: reservations,
    error,
    mutate,
  } = useSWR<Reservation[]>(
    `/api/reservations?${queryParams.toString()}`,
    fetcher
  );

  const filteredReservations = reservations?.filter((r) => {
    if (!searchTerm) return true;
    const customerName =
      `${r.customer?.first_name} ${r.customer?.last_name}`.toLowerCase();
    const phone = r.customer?.phone?.toLowerCase() || "";
    return (
      customerName.includes(searchTerm.toLowerCase()) ||
      phone.includes(searchTerm.toLowerCase())
    );
  });

  const handleStatusChange = async (id: string, newStatus: string) => {
    await fetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    mutate();
    setSelectedReservation(null);
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-destructive">Failed to load reservations</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Reservations</h1>
        <p className="text-muted-foreground">
          Manage all surf lessons and accommodation bookings
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by customer name or phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-48">
            <Filter className="mr-2 h-4 w-4" />
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Reservations List */}
      <Card>
        <CardHeader>
          <CardTitle>
            All Reservations ({filteredReservations?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-sm text-muted-foreground">
                  <th className="pb-3 font-medium">Customer</th>
                  <th className="pb-3 font-medium">Service</th>
                  <th className="pb-3 font-medium">Date</th>
                  <th className="pb-3 font-medium">People</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Total</th>
                  <th className="pb-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {!filteredReservations || filteredReservations.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No reservations found
                    </td>
                  </tr>
                ) : (
                  filteredReservations.map((reservation) => (
                    <tr key={reservation.id} className="text-sm">
                      <td className="py-3">
                        <div>
                          <p className="font-medium">
                            {reservation.customer?.first_name}{" "}
                            {reservation.customer?.last_name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {reservation.customer?.phone}
                          </p>
                        </div>
                      </td>
                      <td className="py-3">
                        <div>
                          {/* Surf record (incl. Surf+Stay with unresolved course_id) */}
                          {reservation.course_date && (
                            <p className="font-medium">{surfLabel(reservation)}</p>
                          )}
                          {/* Accommodation record */}
                          {!reservation.course_date && reservation.accommodation_type && (
                            <p className="font-medium">{roomLabel(reservation.accommodation_type)}</p>
                          )}
                          {reservation.course_date && reservation.accommodation_type && (
                            <p className="text-xs text-muted-foreground">
                              + {roomLabel(reservation.accommodation_type)}
                            </p>
                          )}
                          {!reservation.course_date && !reservation.accommodation_type && (
                            <p className="text-muted-foreground">-</p>
                          )}
                        </div>
                      </td>
                      <td className="py-3">
                        {reservation.course_date && (
                          <div>
                            <p>
                              {format(
                                new Date(reservation.course_date),
                                "MMM d, yyyy"
                              )}
                              {reservation.surf_end_date && reservation.surf_end_date !== reservation.course_date && (
                                <span className="text-xs text-muted-foreground">
                                  {" "}→ {format(new Date(reservation.surf_end_date), "MMM d")}
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {reservation.course_time}
                            </p>
                          </div>
                        )}
                        {!reservation.course_date && reservation.check_in && (
                          <div>
                            <p>
                              {format(new Date(reservation.check_in), "MMM d")}{" "}
                              -{" "}
                              {format(
                                new Date(reservation.check_out!),
                                "MMM d"
                              )}
                            </p>
                          </div>
                        )}
                      </td>
                      <td className="py-3">
                        <p>{reservation.number_of_people} person(s)</p>
                        {reservation.number_of_non_swimmers > 0 && (
                          <p className="text-xs text-orange-600">
                            {reservation.number_of_non_swimmers} non-swimmer(s)
                          </p>
                        )}
                      </td>
                      <td className="py-3">
                        <Badge
                          variant="outline"
                          className={statusColors[reservation.status]}
                        >
                          {reservation.status}
                        </Badge>
                      </td>
                      <td className="py-3 font-medium">
                        Rs. {reservation.total_price.toLocaleString()}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setSelectedReservation(reservation)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Edit reservation"
                            onClick={() => openEdit(reservation)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {reservation.status === "pending" && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-green-600 hover:text-green-700"
                                onClick={() =>
                                  handleStatusChange(
                                    reservation.id,
                                    "confirmed"
                                  )
                                }
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-600 hover:text-red-700"
                                onClick={() =>
                                  handleStatusChange(
                                    reservation.id,
                                    "cancelled"
                                  )
                                }
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Reservation Detail Dialog */}
      <Dialog
        open={!!selectedReservation}
        onOpenChange={() => setSelectedReservation(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Reservation Details</DialogTitle>
          </DialogHeader>
          {selectedReservation && (
            <div className="space-y-4">
              {/* Customer Info */}
              <div className="rounded-lg bg-muted p-4">
                <h4 className="font-medium mb-2">Customer</h4>
                <p>
                  {selectedReservation.customer?.first_name}{" "}
                  {selectedReservation.customer?.last_name}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedReservation.customer?.phone}
                </p>
                {selectedReservation.customer?.email && (
                  <p className="text-sm text-muted-foreground">
                    {selectedReservation.customer.email}
                  </p>
                )}
              </div>

              {/* Service Info */}
              <div className="rounded-lg bg-muted p-4">
                <h4 className="font-medium mb-2">Service</h4>
                {selectedReservation.course && (
                  <div>
                    <p className="font-medium">
                      {selectedReservation.course.name}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {selectedReservation.course.duration} -{" "}
                      {selectedReservation.course_date &&
                        format(
                          new Date(selectedReservation.course_date),
                          "MMMM d, yyyy"
                        )}{" "}
                      at {selectedReservation.course_time}
                    </p>
                  </div>
                )}
                {selectedReservation.accommodation_type && (
                  <div className="mt-2">
                    <p className="capitalize">
                      {selectedReservation.accommodation_type} Accommodation
                    </p>
                    {selectedReservation.check_in && (
                      <p className="text-sm text-muted-foreground">
                        {format(
                          new Date(selectedReservation.check_in),
                          "MMM d"
                        )}{" "}
                        -{" "}
                        {format(
                          new Date(selectedReservation.check_out!),
                          "MMM d, yyyy"
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Booking Info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg bg-muted p-4">
                  <h4 className="font-medium mb-1">People</h4>
                  <p>{selectedReservation.number_of_people} person(s)</p>
                  {selectedReservation.number_of_non_swimmers > 0 && (
                    <p className="text-sm text-orange-600">
                      {selectedReservation.number_of_non_swimmers}{" "}
                      non-swimmer(s)
                    </p>
                  )}
                </div>
                <div className="rounded-lg bg-muted p-4">
                  <h4 className="font-medium mb-1">Total</h4>
                  <p className="text-lg font-bold">
                    Rs. {selectedReservation.total_price.toLocaleString()}
                  </p>
                </div>
              </div>

              {/* Special Requests */}
              {selectedReservation.special_requests && (
                <div className="rounded-lg bg-muted p-4">
                  <h4 className="font-medium mb-2">Special Requests</h4>
                  <p className="text-sm">
                    {selectedReservation.special_requests}
                  </p>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-4">
                {selectedReservation.status === "pending" && (
                  <>
                    <Button
                      className="flex-1"
                      onClick={() =>
                        handleStatusChange(selectedReservation.id, "confirmed")
                      }
                    >
                      <Check className="mr-2 h-4 w-4" />
                      Confirm
                    </Button>
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={() =>
                        handleStatusChange(selectedReservation.id, "cancelled")
                      }
                    >
                      <X className="mr-2 h-4 w-4" />
                      Cancel
                    </Button>
                  </>
                )}
                {selectedReservation.status === "confirmed" && (
                  <Button
                    className="flex-1"
                    onClick={() =>
                      handleStatusChange(selectedReservation.id, "completed")
                    }
                  >
                    Mark as Completed
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Edit Reservation Dialog ─────────────────────────────────────── */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && !saving && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Reservation</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {editing.customer?.first_name} {editing.customer?.last_name} —{" "}
                {editing.course_date ? surfLabel(editing) : roomLabel(editing.accommodation_type)}
              </p>

              {editIsAccommodation && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Check-in</label>
                      <Input type="date" value={editForm.check_in}
                        onChange={(e) => setEditForm((f) => ({ ...f, check_in: e.target.value }))} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Check-out</label>
                      <Input type="date" value={editForm.check_out}
                        onChange={(e) => setEditForm((f) => ({ ...f, check_out: e.target.value }))} />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Room type</label>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={editForm.accommodation_type}
                      onChange={(e) => setEditForm((f) => ({ ...f, accommodation_type: e.target.value }))}
                    >
                      {EDITABLE_ROOM_TYPES.map((t) => (
                        <option key={t} value={t}>{ROOM_TYPE_DISPLAY[t]}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {editIsSurf && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Course date</label>
                    <Input type="date" value={editForm.course_date}
                      onChange={(e) => setEditForm((f) => ({ ...f, course_date: e.target.value }))} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Time slot</label>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={editForm.course_time}
                      onChange={(e) => setEditForm((f) => ({ ...f, course_time: e.target.value }))}
                    >
                      <option value="08:00">08:00</option>
                      <option value="10:00">10:00</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">People</label>
                  <Input type="number" min={1} value={editForm.number_of_people}
                    onChange={(e) => setEditForm((f) => ({ ...f, number_of_people: Math.max(1, Number(e.target.value)) }))} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Total price (Rs)</label>
                  <div className="flex gap-1">
                    <Input type="number" min={0} value={editForm.total_price}
                      onChange={(e) => setEditForm((f) => ({ ...f, total_price: Math.max(0, Number(e.target.value)) }))} />
                    {editIsAccommodation && (
                      <Button type="button" variant="outline" size="sm" className="shrink-0 px-2 text-xs"
                        title="Recalculate seasonal per-night price for the selected dates and room. You can still override manually."
                        onClick={recalcPrice}>
                        ↻
                      </Button>
                    )}
                  </div>
                  {editIsAccommodation && (
                    <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
                      ↻ recalculates by season per night; override manually for agreed discounts
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Notes</label>
                <textarea
                  className="min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editForm.special_requests}
                  onChange={(e) => setEditForm((f) => ({ ...f, special_requests: e.target.value }))}
                />
              </div>

              {editError && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{editError}</p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button>
                <Button disabled={saving} onClick={saveEdit}>{saving ? "Saving..." : "Save changes"}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
