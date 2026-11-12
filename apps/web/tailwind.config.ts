import type { Config } from "tailwindcss";

// Tokens from docs/uiux-brief-relay.md.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#070B14",
        surface: "rgba(255,255,255,0.06)",
        line: "rgba(255,255,255,0.18)",
        ink: "#F4F1EA",
        muted: "#A9B1C3",
        accent: "#FFB347",
        success: "#3DDC97",
        danger: "#FF5C5C",
      },
      fontFamily: {
        display: ["Anton", "Impact", "Haettenschweiler", "Arial Narrow Bold", "sans-serif"],
        serif: ["Playfair Display", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
