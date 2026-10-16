// The UI is the static SPA at `/` (see next.config.ts); this app only hosts
// the API routes and the flow route.
export const metadata = {
  title: 'durable-harness',
  description: 'Durable agent sessions on Vercel Workflow: crash the process and the session resumes from its log.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
