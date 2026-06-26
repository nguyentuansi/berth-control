import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { getLatestSample, subscribeToSamples } from '$lib/server/monitor/collector.js';

// SSE feed: latest host monitoring sample, pushed on every collector tick.
//
// Pattern mirrors /api/state — single subscription per client, server pushes
// without polling. The collector exposes both a "current snapshot" (for the
// initial `meta` event) and a tick listener (for subsequent `sample` events).
//
// Reading permission: any signed-in user. We don't expose admin-only data;
// the metrics are about the machine berth runs on, not about other users'
// apps.

export const GET: RequestHandler = async ({ locals, request }) => {
  requireUser(locals);

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const enc = new TextEncoder();
      const send = (event: string, obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Initial snapshot — null if the collector hasn't ticked yet.
      const initial = getLatestSample();
      send('meta', { hasInitial: initial != null });
      if (initial) send('sample', initial);

      const unsubscribe = subscribeToSamples((snap) => send('sample', snap));

      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(': ka\n\n'));
        } catch {
          closed = true;
        }
      }, 15_000);
      keepalive.unref();

      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
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
