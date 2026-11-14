"use client";

import { CohorlyErrorBoundary } from "@cohorly/nextjs";
import { useState } from "react";

function Bomb() {
  const [armed, setArmed] = useState(false);
  if (armed) throw new Error("client component boom");
  return (
    <button type="button" onClick={() => setArmed(true)}>
      Throw while rendering
    </button>
  );
}

export default function ClientBoom() {
  return (
    <main>
      <CohorlyErrorBoundary
        fallback={({ reset }) => (
          <button type="button" onClick={reset}>
            Something went wrong. Try again
          </button>
        )}
      >
        <Bomb />
      </CohorlyErrorBoundary>
    </main>
  );
}
