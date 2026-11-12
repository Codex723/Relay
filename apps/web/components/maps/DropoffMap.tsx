"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef } from "react";

export const TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
export const TILE_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";

export interface Point {
  lat: number;
  lng: number;
}

export const dot = (kind: "vendor" | "drop" | "rider") =>
  L.divIcon({ className: "", html: `<span class="map-dot map-dot--${kind}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] });

// A map where the customer taps to drop a pin. The vendor is shown as a reference point.
export default function DropoffMap({ center, vendor, value, onChange }: { center: Point; vendor: Point; value: Point | null; onChange: (p: Point) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pin = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { center: [center.lat, center.lng], zoom: 13 });
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19, subdomains: "abcd" }).addTo(m);
    L.marker([vendor.lat, vendor.lng], { icon: dot("vendor"), keyboard: false, title: "Vendor" }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => onChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      pin.current = null;
    };
    // The map is created once; later changes to the pin are applied below.
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (value) {
      if (pin.current) pin.current.setLatLng([value.lat, value.lng]);
      else pin.current = L.marker([value.lat, value.lng], { icon: dot("drop"), keyboard: false, title: "Drop-off" }).addTo(m);
      m.panTo([value.lat, value.lng]);
    } else if (pin.current) {
      pin.current.remove();
      pin.current = null;
    }
  }, [value]);

  return <div ref={el} className="h-72 w-full overflow-hidden rounded-2xl" role="application" aria-label="Map: tap to set your drop-off point" data-testid="dropoff-map" />;
}
