import type { Database } from "../db";
import type { Realtime } from "../realtime/realtime";

// Saves a rider's position and passes it on to the live feed. Used by both the HTTP route and the socket event.
export async function updateRiderLocation(
  db: Database,
  realtime: Realtime,
  riderId: string,
  lat: number,
  lng: number,
): Promise<void> {
  await db.updateTable("riders").set({ current_lat: lat, current_lng: lng, last_seen_at: new Date() }).where("user_id", "=", riderId).execute();
  realtime.riderLocation(riderId, lat, lng);
}
