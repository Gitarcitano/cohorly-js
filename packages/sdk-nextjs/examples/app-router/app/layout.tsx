import { CohorlyProvider } from "@cohorly/nextjs";
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CohorlyProvider
          token={process.env.NEXT_PUBLIC_COHORLY_TOKEN}
          apiHost={process.env.NEXT_PUBLIC_COHORLY_API_HOST}
          captureExceptions
          trackPageviews
        >
          {children}
        </CohorlyProvider>
      </body>
    </html>
  );
}
