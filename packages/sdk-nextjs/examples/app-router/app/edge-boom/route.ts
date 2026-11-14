export const runtime = "edge";

export function GET(): Response {
  throw new Error("edge route handler boom");
}
