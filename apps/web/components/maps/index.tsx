"use client";

import dynamic from "next/dynamic";

// Leaflet needs the browser, so the maps are loaded on the client only.
const placeholder = () => <div className="h-72 w-full animate-pulse rounded-2xl bg-surface" aria-hidden="true" />;
export const DropoffMap = dynamic(() => import("./DropoffMap"), { ssr: false, loading: placeholder });
export const TrackingMap = dynamic(() => import("./TrackingMap"), { ssr: false, loading: placeholder });
