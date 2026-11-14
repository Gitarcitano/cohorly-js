"use client";

import { cohorly } from "@cohorly/web";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // An error with a digest came from the server, where onRequestError already captured it.
    if (error.digest !== undefined) return;
    try {
      cohorly.captureException(error, {
        mechanism: { type: "nextjs.global-error", handled: true },
      });
    } catch {
      // The provider never initialized the browser SDK: nothing to capture with.
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <h2>Something went wrong.</h2>
        <button type="button" onClick={() => reset()}>
          Try again
        </button>
      </body>
    </html>
  );
}
