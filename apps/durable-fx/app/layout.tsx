export const metadata = { title: 'durable fx', description: "libfx's durable agent on Vercel" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, font: '15px/1.5 system-ui, sans-serif', background: '#0a0a0a', color: '#ededed' }}>
        {children}
      </body>
    </html>
  );
}
