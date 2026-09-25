// Room inventory — keyed by the unified room type convention used everywhere:
// "fan"         = Standard Fan (non-AC)        — 1 room
// "ac"          = Superior AC                   — 3 rooms
// "premium_fan" = Premium Fan (non-AC)          — 1 room
// "premium_ac"  = Premium AC                    — 3 rooms
// Note: premium_fan and premium_ac share the same nightly price (premium tier).
export const ROOM_INVENTORY: Record<string, number> = {
  fan:         1,
  ac:          3,
  premium_fan: 1,
  premium_ac:  3,
};
