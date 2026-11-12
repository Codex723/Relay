"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { useAuth } from "./auth";
import { API_URL } from "./config";
import type { OrderStatus } from "./orderStatus";

export interface RiderPosition {
  lat: number;
  lng: number;
  at: string;
}

interface Options {
  orderId: string;
  enabled: boolean;
  onStatus: (status: OrderStatus) => void;
  onLocation: (pos: RiderPosition) => void;
  /** Called every 10 seconds while the live connection is down, to fetch the order the ordinary way. */
  poll: () => void;
}

// Live updates for one order. If the connection drops, the page falls back to polling; when the server ends the
// connection because the access token expired, we fetch a new token and reconnect with it.
export function useOrderLive({ orderId, enabled, onStatus, onLocation, poll }: Options): { connected: boolean } {
  const { token, refresh } = useAuth();
  const [connected, setConnected] = useState(false);
  const handlers = useRef({ onStatus, onLocation, poll });
  handlers.current = { onStatus, onLocation, poll };

  useEffect(() => {
    if (!enabled || !token) return;
    const socket = io(API_URL, { auth: { token }, transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      setConnected(true);
      socket.emit("order:subscribe", { orderId });
    });
    socket.on("disconnect", (reason) => {
      setConnected(false);
      // The server closes the socket when the access token runs out. A new token re-runs this effect.
      if (reason === "io server disconnect") void refresh();
    });
    socket.on("connect_error", (err) => {
      setConnected(false);
      if (err.message === "UNAUTHENTICATED") void refresh();
    });
    socket.on("order:status", (p: { orderId: string; status: OrderStatus }) => {
      if (p.orderId === orderId) handlers.current.onStatus(p.status);
    });
    socket.on("rider:location", (p: { orderId: string; lat: number; lng: number; at: string }) => {
      if (p.orderId === orderId) handlers.current.onLocation({ lat: p.lat, lng: p.lng, at: p.at });
    });
    return () => {
      socket.disconnect();
      setConnected(false);
    };
  }, [enabled, token, orderId, refresh]);

  useEffect(() => {
    if (!enabled || connected) return;
    const timer = setInterval(() => handlers.current.poll(), 10_000);
    return () => clearInterval(timer);
  }, [enabled, connected]);

  return { connected };
}
