"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef } from "react";
import { TILE_ATTRIBUTION, TILE_URL, dot, type Point } from "./DropoffMap";

// Vendor, drop-off and (once known) the rider, which moves as live updates arrive.
export default function TrackingMap({ vendor, drop, rider }: { vendor: Point; drop: Point; rider: Point | null }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const riderMarker = useRef<L.Marker | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { center: [vendor.lat, vendor.lng], zoom: 14 });
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19, subdomains: "abcd" }).addTo(m);
    L.marker([vendor.lat, vendor.lng], { icon: dot("vendor"), keyboard: false, title: "Vendor" }).addTo(m);
    L.marker([drop.lat, drop.lng], { icon: dot("drop"), keyboard: false, title: "Your drop-off" }).addTo(m);
    m.fitBounds(L.latLngBounds([vendor.lat, vendor.lng], [drop.lat, drop.lng]), { padding: [40, 40], maxZoom: 16 });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      riderMarker.current = null;
      fitted.current = false;
    };
  }, [vendor.lat, vendor.lng, drop.lat, drop.lng]);

  useEffect(() => {
    const m = map.current;
    if (!m || !rider) return;
    if (riderMarker.current) riderMarker.current.setLatLng([rider.lat, rider.lng]);
    else riderMarker.current = L.marker([rider.lat, rider.lng], { icon: dot("rider"), keyboard: false, title: "Your rider", zIndexOffset: 1000 }).addTo(m);
    if (!fitted.current) {
      // Zoom to include the rider the first time they appear, then leave the view alone so the customer can pan.
      fitted.current = true;
      m.fitBounds(L.latLngBounds([vendor.lat, vendor.lng], [drop.lat, drop.lng]).extend([rider.lat, rider.lng]), { padding: [40, 40], maxZoom: 16 });
    }
  }, [rider, vendor.lat, vendor.lng, drop.lat, drop.lng]);

  return <div ref={el} className="h-72 w-full overflow-hidden rounded-2xl sm:h-96" role="img" aria-label="Map showing the vendor, your drop-off point and your rider" data-testid="tracking-map" />;
}
