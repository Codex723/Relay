import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodIssue } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// Duck-typed: schemas come from @relay/shared, which can load a different copy of zod than this
// package (CJS vs ESM), and `instanceof` would then fail and turn a 400 into a 500.
function zodIssues(err: unknown): ZodIssue[] | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; issues?: unknown };
  return e.name === "ZodError" && Array.isArray(e.issues) ? (e.issues as ZodIssue[]) : null;
}

export const sendError = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

// Express 4 does not catch rejected promises, so wrap async handlers.
export const asyncHandler =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
  const issues = zodIssues(err);
  if (issues) {
    const message = issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return sendError(res, 400, "VALIDATION_ERROR", message);
  }
  if (err instanceof SyntaxError && "body" in err) {
    return sendError(res, 400, "INVALID_JSON", "Request body is not valid JSON.");
  }
  // Never leak internals to the client; log them server-side.
  console.error(err);
  return sendError(res, 500, "INTERNAL", "Something went wrong.");
}
