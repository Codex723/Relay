// The browser and the server both use this address. Next bakes NEXT_PUBLIC_* values in at build time.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
