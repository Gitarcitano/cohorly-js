export const dynamic = "force-dynamic";

export default function Boom(): never {
  throw new Error("server component boom");
}
