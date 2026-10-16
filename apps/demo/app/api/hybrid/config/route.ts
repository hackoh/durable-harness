import { hybridConfig } from '@/lib/sessions';

/** The model and fx configuration hash hybrid sessions are replayed with here (see `hybridConfig`). */
export async function GET() {
  return Response.json(await hybridConfig(), { headers: { 'cache-control': 'no-store' } });
}
