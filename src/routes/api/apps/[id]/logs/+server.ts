import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { and, eq, isNull, gt, asc } from 'drizzle-orm';

/** SSE log stream: replays everything from `since_id` then tails new chunks. */
export const GET: RequestHandler = async ({ params, url, request }) => {
  const appId = params.id;
  const since = Number(url.searchParams.get('since') ?? 0);
  // Pin to the latest open run if any, else the most recent run overall.
  const open = db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.app_id, appId), isNull(schema.runs.stopped_at)))
    .get();
  const last = open
    ? open
    : db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.app_id, appId))
        .orderBy(schema.runs.id)
        .all()
        .at(-1);
  let runId = last?.id ?? null;
  let cursor = since;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (event: string, obj: unknown) => {
        if (closed) return;
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`));
      };
      send('meta', { runId });

      const flush = () => {
        if (!runId) return;
        const rows = db
          .select()
          .from(schema.log_chunks)
          .where(and(eq(schema.log_chunks.run_id, runId), gt(schema.log_chunks.id, cursor)))
          .orderBy(asc(schema.log_chunks.id))
          .limit(500)
          .all();
        for (const r of rows) {
          send('log', { id: r.id, ts: r.ts.getTime(), stream: r.stream, line: r.line });
          cursor = r.id;
        }
      };
      flush();
      const iv = setInterval(flush, 800);
      const ka = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(`: ka\n\n`));
      }, 15_000);
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(iv);
        clearInterval(ka);
        try {
          controller.close();
        } catch {
          /* */
        }
      });
    }
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
};
