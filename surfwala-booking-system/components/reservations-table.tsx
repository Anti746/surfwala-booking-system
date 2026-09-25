"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Reservation } from "@/lib/types";
import { calcStayPrice } from "@/lib/pricing";
import { Check, X, Pencil } from "lucide-react";

interface ReservationsTableProps {
  reservations: Reservation[];
  onConfirm?: (id: string) => void | Promise<void>;
  onCancel?: (id: string) => void | Promise<void>;
}

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-200",
  confirmed: "bg-green-100 text-green-800 border-green-200",
  cancelled: "bg-red-100 text-red-800 border-red-200",
  completed: "bg-blue-100 text-blue-800 border-blue-200",
};

// Maps unified room key to display name
const ROOM_TYPE_DISPLAY: Record<string, string> = {
  fan:         "Fan Room",
  ac:          "AC Room",
  premium_fan: "Premium Fan Room",
  premium_ac:  "Premium AC Room",
  // Legacy DB types (pre-migration safety)
  standard: "Fan Room",
  superior: "AC Room",
  premium:  "Premium AC Room",
};

const EDITABLE_ROOM_TYPES = ["fan", "ac", "premium_fan", "premium_ac"] as const;

function getRoomLabel(accType: string | null): string {
  if (!accType) return "-";
  return ROOM_TYPE_DISPLAY[accType] ?? `${accType} Room`;
}

// For Surf+Stay the surf record has no course name (course_id may be null).
// Use course_type to derive a readable label.
const COURSE_TYPE_LABEL: Record<string, string> = {
  teaser:  "1 Day Course",
  plunge:  "3 Day Course",
  immerse: "5 Day Course",
  week:    "7 Day Course",
  kids:    "Kids Lesson",
  private: "Private Lesson",
};

function getServiceLabel(r: Reservation): string {
  if (r.course?.name) return r.course.name;
  if (r.course_date && !r.check_in) {
    if (r.course_type) return COURSE_TYPE_LABEL[r.course_type] ?? r.course_type;
    return "Surf Lesson";
  }
  if (r.accommodation_type) return getRoomLabel(r.accommodation_type);
  return "-";
}

// ── Edit modal state shape ────────────────────────────────────────────────────
interface EditForm {
  check_in: string;
  check_out: string;
  accommodation_type: string;
  course_date: string;
  course_time: string;
  number_of_people: number;
  total_price: number;
  special_requests: string;
}

export function ReservationsTable({
  reservations,
  onConfirm,
  onCancel,
}: ReservationsTableProps) {
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

  const isAccommodation = editing ? Boolean(editing.check_in || editing.accommodation_type) : false;
  const isSurf = editing ? Boolean(editing.course_date) : false;

  // Seasonal price recalculation for the CURRENT form values (admin can still
  // manually override the price field afterwards — e.g. agreed discount).
  const recalcPrice = () => {
    if (!isAccommodation || !editForm.check_in || !editForm.check_out || !editForm.accommodation_type) return;
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
      if (isAccommodation) {
        payload.check_in = editForm.check_in || null;
        payload.check_out = editForm.check_out || null;
        payload.accommodation_type = editForm.accommodation_type || null;
      }
      if (isSurf) {
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
      window.location.reload();
    } catch {
      setEditError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = async (id: string) => {
    if (onConfirm) { await onConfirm(id); return; }
    const res = await fetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "confirmed" }),
    });
    if (!res.ok) { alert("Error updating status"); return; }
    window.location.reload();
  };

  const handleCancel = async (id: string) => {
    if (onCancel) { await onCancel(id); return; }
    const res = await fetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    if (!res.ok) { alert("Error updating status"); return; }
    window.location.reload();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Reservations</CardTitle>
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
              {reservations.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted-foreground">
                    No reservations found
                  </td>
                </tr>
              ) : (
                reservations.map((reservation) => (
                  <tr key={reservation.id} className="text-sm">
                    <td className="py-3">
                      <p className="font-medium">
                        {reservation.customer?.first_name}{" "}
                        {reservation.customer?.last_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {reservation.customer?.phone}
                      </p>
                    </td>

                    <td className="py-3">
                      <p className="font-medium">{getServiceLabel(reservation)}</p>
                      {reservation.course_date && reservation.check_in && (
                        <p className="text-xs text-muted-foreground">Surf + Stay</p>
                      )}
                    </td>

                    <td className="py-3">
                      {reservation.check_in && reservation.check_out ? (
                        <>
                          {format(new Date(reservation.check_in), "MMM d")}
                          {" – "}
                          {format(new Date(reservation.check_out), "MMM d, yyyy")}
                        </>
                      ) : reservation.course_date ? (
                        <>
                          {format(new Date(reservation.course_date), "MMM d, yyyy")}
                          {reservation.surf_end_date && reservation.surf_end_date !== reservation.course_date && (
                            <span className="block text-xs text-muted-foreground">
                              → {format(new Date(reservation.surf_end_date), "MMM d")}
                            </span>
                          )}
                          {reservation.course_time && (
                            <span className="block text-xs text-muted-foreground">{reservation.course_time}</span>
                          )}
                        </>
                      ) : "-"}
                    </td>

                    <td className="py-3">{reservation.number_of_people} person(s)</td>

                    <td className="py-3">
                      <Badge variant="outline" className={statusColors[reservation.status]}>
                        {reservation.status}
                      </Badge>
                    </td>

                    <td className="py-3 font-medium">
                      Rs. {reservation.total_price?.toLocaleString() ?? 0}
                    </td>

                    <td className="py-3">
                      <div className="flex gap-2">
                        <Button
                          size="sm" variant="ghost"
                          title="Edit reservation"
                          onClick={() => openEdit(reservation)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {reservation.status === "pending" && (
                          <>
                            <Button
                              size="sm" variant="ghost"
                              className="text-green-600 hover:text-green-700"
                              onClick={() => handleConfirm(reservation.id)}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              className="text-red-600 hover:text-red-700"
                              onClick={() => handleCancel(reservation.id)}
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

        {/* ── Edit modal ─────────────────────────────────────────────────── */}
        {editing && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && setEditing(null)}>
            <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <h3 className="mb-1 text-lg font-semibold">Edit Reservation</h3>
              <p className="mb-4 text-sm text-muted-foreground">
                {editing.customer?.first_name} {editing.customer?.last_name} — {getServiceLabel(editing)}
              </p>

              <div className="space-y-3">
                {isAccommodation && (
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

                {isSurf && (
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
                      {isAccommodation && (
                        <Button type="button" variant="outline" size="sm" className="shrink-0 px-2 text-xs"
                          title="Recalculate seasonal price for the selected dates and room. You can still override manually."
                          onClick={recalcPrice}>
                          ↻
                        </Button>
                      )}
                    </div>
                    {isAccommodation && (
                      <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
                        ↻ recalculates by season per night; you can override manually (e.g. agreed discount)
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
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
