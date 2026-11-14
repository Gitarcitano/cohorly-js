import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Cohorly error tracking</h1>
      <ul>
        <li>
          <Link href="/boom">Server component error</Link>
        </li>
        <li>
          <Link href="/client-boom">Client component error (CohorlyErrorBoundary)</Link>
        </li>
        <li>
          <a href="/api/boom">Route handler error (Node.js runtime)</a>
        </li>
        <li>
          <a href="/edge-boom">Route handler error (Edge runtime)</a>
        </li>
      </ul>
    </main>
  );
}
