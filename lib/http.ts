import axios from "axios";

type ApiErrorBody = {
  error?: unknown;
  details?: unknown;
};

/**
 * Returns the parsed JSON body from an axios error response, when present.
 * Useful for forms that need structured validation details.
 */
export function apiErrorBody<T = ApiErrorBody>(error: unknown): T | null {
  if (!axios.isAxiosError(error)) {
    return null;
  }

  const data = error.response?.data;
  return data && typeof data === "object" ? (data as T) : null;
}

/**
 * Prefers the API's `{ error }` message and falls back to a caller-provided
 * message. Axios throws on non-2xx responses, so this replaces the old
 * `response.ok` / `payload.error` checks.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const body = apiErrorBody<ApiErrorBody>(error);

  if (body && typeof body.error === "string" && body.error.trim()) {
    return body.error;
  }

  return fallback;
}

export { axios };
