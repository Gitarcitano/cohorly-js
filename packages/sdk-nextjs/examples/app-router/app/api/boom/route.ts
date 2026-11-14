export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  throw new Error("route handler boom");
}
