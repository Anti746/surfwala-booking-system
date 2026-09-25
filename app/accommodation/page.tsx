"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Home, Snowflake, Plus, Pencil, Trash2, Check, X as XIcon, Loader2 } from "lucide-react";
import type { AccommodationType } from "@/lib/types";

interface SeasonalPricingRow {
  id: string;
  season: "peaceful" | "loafer" | "busy" | "blackout";
  room_type: "fan" | "ac" | "premium"; // 3 price tiers — "premium" applies to both Premium Fan and Premium AC rooms (same price)
  per_night_price: number;
  package_3_day: number;
  package_5_day: number;
  package_7_day: number;
  extra_bed_price: number;
}

const SEASON_LABELS: Record<string, string> = {
  peaceful: "Peaceful Season (Oct 1 – Nov 15 / Feb 16 – Apr 30)",
  loafer: "Loafer Season (May 1 – Sep 30)",
  busy: "Busy Season (Nov 16 – Dec 19 / Jan 8 – Feb 15)",
  blackout: "Blackout (Dec 20 – Jan 7, no Surf+Stay packages)",
};
const SEASON_ORDER = ["peaceful", "loafer", "busy", "blackout"];
// "Premium" covers both Premium Fan Room and Premium AC Room — they always
// share the same price, so there is only one editable row for both.
const ROOM_TYPE_LABELS: Record<string, string> = {
  fan: "Fan Room",
  ac: "AC Room",
  premium: "Premium (Fan + AC)",
};

interface Room {
  id: string;
  name: string;
  accommodation_type_id: string;
  is_available: boolean;
  accommodation_type?: AccommodationType;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return text ? JSON.parse(text) : [];
};

// ── Seasonal Pricing Section ─────────────────────────────────────────────────
// Editable, grouped by season, used to keep the chatbot's room/package prices
// in sync with what's actually offered. Inline edit per row (per_night + 3/5/7
// day package prices + extra bed price).
function SeasonalPricingSection() {
  const { data: pricing, error } = useSWR<SeasonalPricingRow[]>(
    "/api/seasonal-pricing",
    fetcher
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    per_night_price: 0,
    package_3_day: 0,
    package_5_day: 0,
    package_7_day: 0,
    extra_bed_price: 0,
  });
  const [isSaving, setIsSaving] = useState(false);

  const startEdit = (row: SeasonalPricingRow) => {
    setEditingId(row.id);
    setEditForm({
      per_night_price: row.per_night_price,
      package_3_day: row.package_3_day,
      package_5_day: row.package_5_day,
      package_7_day: row.package_7_day,
      extra_bed_price: row.extra_bed_price,
    });
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async (row: SeasonalPricingRow) => {
    setIsSaving(true);
    try {
      await fetch("/api/seasonal-pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season: row.season, room_type: row.room_type, ...editForm }),
      });
      mutate("/api/seasonal-pricing");
      setEditingId(null);
    } catch (err) {
      console.error("Failed to save seasonal price:", err);
    } finally {
      setIsSaving(false);
    }
  };

  if (error) {
    return (
      <Card className="col-span-full">
        <CardContent className="py-8 text-center text-destructive">
          Failed to load seasonal pricing
        </CardContent>
      </Card>
    );
  }

  if (!pricing) {
    return (
      <Card className="col-span-full">
        <CardContent className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading seasonal pricing...
        </CardContent>
      </Card>
    );
  }

  const bySeasonn: Record<string, SeasonalPricingRow[]> = {};
  for (const row of pricing) {
    if (!bySeasonn[row.season]) bySeasonn[row.season] = [];
    bySeasonn[row.season].push(row);
  }

  return (
    <div className="space-y-4">
      {SEASON_ORDER.filter((s) => bySeasonn[s]?.length).map((season) => (
        <Card key={season}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{SEASON_LABELS[season] ?? season}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-2 font-medium">Room Type</th>
                    <th className="p-2 font-medium">Per Night</th>
                    <th className="p-2 font-medium">3 Day Package</th>
                    <th className="p-2 font-medium">5 Day Package</th>
                    <th className="p-2 font-medium">7 Day Package</th>
                    <th className="p-2 font-medium">Extra Bed/Night</th>
                    <th className="p-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {bySeasonn[season]
                    .sort((a, b) => a.room_type.localeCompare(b.room_type))
                    .map((row) => {
                      const isEditing = editingId === row.id;
                      return (
                        <tr key={row.id} className="border-b last:border-0">
                          <td className="p-2 font-medium">{ROOM_TYPE_LABELS[row.room_type] ?? row.room_type}</td>
                          {(["per_night_price", "package_3_day", "package_5_day", "package_7_day", "extra_bed_price"] as const).map((field) => (
                            <td key={field} className="p-2">
                              {isEditing ? (
                                <Input
                                  type="number"
                                  value={editForm[field]}
                                  onChange={(e) => setEditForm({ ...editForm, [field]: Number(e.target.value) })}
                                  className="h-8 w-24"
                                />
                              ) : (
                                <span>{row[field].toLocaleString()} Rs</span>
                              )}
                            </td>
                          ))}
                          <td className="p-2 text-right">
                            {isEditing ? (
                              <div className="flex justify-end gap-1">
                                <Button variant="ghost" size="icon" disabled={isSaving} onClick={() => saveEdit(row)}>
                                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4 text-emerald-600" />}
                                </Button>
                                <Button variant="ghost" size="icon" disabled={isSaving} onClick={cancelEdit}>
                                  <XIcon className="h-4 w-4 text-muted-foreground" />
                                </Button>
                              </div>
                            ) : (
                              <Button variant="ghost" size="icon" onClick={() => startEdit(row)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AccommodationPage() {
  const { data: accommodationTypes, error: accError } = useSWR<AccommodationType[]>(
    "/api/accommodation",
    fetcher
  );

  const [isAccDialogOpen, setIsAccDialogOpen] = useState(false);
  const [editingAcc, setEditingAcc] = useState<AccommodationType | null>(null);

  // Accommodation form state
  const [accForm, setAccForm] = useState({
    name: "",
    type: "dorm",
    description: "",
    has_ac: false,
    price_per_night: 0,
  });

  const resetAccForm = () => {
    setAccForm({
      name: "",
      type: "dorm",
      description: "",
      has_ac: false,
      price_per_night: 0,
    });
    setEditingAcc(null);
  };

  const openAccDialog = (acc?: AccommodationType) => {
    if (acc) {
      setEditingAcc(acc);
      setAccForm({
        name: acc.name,
        type: acc.type,
        description: acc.description || "",
        has_ac: acc.has_ac,
        price_per_night: acc.price_per_night,
      });
    } else {
      resetAccForm();
    }
    setIsAccDialogOpen(true);
  };


  const handleSaveAcc = async () => {
    try {
      if (editingAcc) {
        await fetch(`/api/accommodation/${editingAcc.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(accForm),
        });
      } else {
        await fetch("/api/accommodation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(accForm),
        });
      }
      mutate("/api/accommodation");
      setIsAccDialogOpen(false);
      resetAccForm();
    } catch (err) {
      console.error("Failed to save accommodation:", err);
    }
  };

  const handleDeleteAcc = async (id: string) => {
    if (!confirm("Are you sure you want to delete this accommodation type?")) return;
    try {
      await fetch(`/api/accommodation/${id}`, { method: "DELETE" });
      mutate("/api/accommodation");
    } catch (err) {
      console.error("Failed to delete accommodation:", err);
    }
  };



  if (accError) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-destructive">Failed to load data</p>
      </div>
    );
  }

  const typeColors: Record<string, string> = {
    dorm: "bg-gray-100 text-gray-800",
    private: "bg-blue-100 text-blue-800",
    suite: "bg-amber-100 text-amber-800",
  };

  return (
    <div className="space-y-6">
      {/* Accommodation Types Section */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Accommodation</h1>
          <p className="text-muted-foreground">Manage accommodation types and rooms</p>
        </div>
        <Button onClick={() => openAccDialog()}>
          <Plus className="h-4 w-4 mr-2" />
          Add Type
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {!accommodationTypes || accommodationTypes.length === 0 ? (
          <Card className="col-span-full">
            <CardContent className="flex items-center justify-center py-8">
              <p className="text-muted-foreground">No accommodation types found</p>
            </CardContent>
          </Card>
        ) : (
          accommodationTypes.map((type) => (
            <Card key={type.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                      <Home className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{type.name}</CardTitle>
                      <Badge variant="outline" className={typeColors[type.type] || ""}>
                        {type.type}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openAccDialog(type)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDeleteAcc(type.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {type.description && (
                  <p className="text-sm text-muted-foreground">{type.description}</p>
                )}
                <div className="flex items-center gap-4">
                  {type.has_ac && (
                    <div className="flex items-center gap-1 text-sm">
                      <Snowflake className="h-4 w-4 text-blue-500" />
                      <span>AC</span>
                    </div>
                  )}
                </div>
                <div className="pt-2 border-t">
                  <p className="text-2xl font-bold">
                    Rs. {type.price_per_night.toLocaleString()}
                    <span className="text-sm font-normal text-muted-foreground">/night</span>
                  </p>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Rooms section removed — it managed a `rooms` DB table that the booking
          system never reads (availability comes from ROOM_INVENTORY + reservations),
          so it only caused confusion. Room capacities live in lib/room-inventory.ts. */}

      {/* Seasonal Pricing Section */}
      <div className="pt-6 border-t">
        <h2 className="text-xl font-bold text-foreground">Seasonal Pricing</h2>
        <p className="text-muted-foreground mb-4">
          Room and Surf+Stay package prices by season — used automatically by the chatbot
        </p>
        <SeasonalPricingSection />
      </div>

      {/* Accommodation Type Dialog */}
      <Dialog open={isAccDialogOpen} onOpenChange={setIsAccDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingAcc ? "Edit Accommodation Type" : "Add Accommodation Type"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input
                value={accForm.name}
                onChange={(e) => setAccForm({ ...accForm, name: e.target.value })}
                placeholder="e.g., Private Room"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Type</label>
              <Select
                value={accForm.type}
                onValueChange={(value) => setAccForm({ ...accForm, type: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dorm">Dorm</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="suite">Suite</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <Input
                value={accForm.description}
                onChange={(e) => setAccForm({ ...accForm, description: e.target.value })}
                placeholder="Optional description"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Price per night (Rs.)</label>
              <Input
                type="number"
                value={accForm.price_per_night}
                onChange={(e) =>
                  setAccForm({ ...accForm, price_per_night: Number(e.target.value) })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="has_ac"
                checked={accForm.has_ac}
                onChange={(e) => setAccForm({ ...accForm, has_ac: e.target.checked })}
                className="h-4 w-4"
              />
              <label htmlFor="has_ac" className="text-sm font-medium">
                Has AC
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAccDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveAcc}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
