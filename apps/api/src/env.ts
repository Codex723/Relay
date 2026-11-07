import path from "node:path";

// Load the repo-root .env for local development. Real environment variables always win,
// and a missing file is fine (CI, Docker and hosting set variables directly).
try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // no .env file
}
