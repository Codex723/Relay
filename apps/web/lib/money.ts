const naira = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" });

// All money is stored and sent as whole kobo; it is only turned into naira for display.
export const formatNaira = (kobo: number): string => naira.format(kobo / 100);

export const formatKm = (meters: number): string => `${(meters / 1000).toFixed(1)} km`;
