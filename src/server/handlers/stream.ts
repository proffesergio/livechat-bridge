import { LiveChatBridgeError } from '../../core/index.js';
import { isSubscribable } from '../transport/types.js';
import type { LiveChatBridge } from '../bridge.js';
import { errorResponse } from './json.js';

const KEEPALIVE_MS = 25_000;

/**
 * Server-Sent Events stream for one channel. Authorizes the viewer with the
 * same ACL used for Pusher auth, then forwards events published onto the
 * configured `SubscribableTransport` (i.e. `SSETransport`) to the browser.
 *
 * Mount at `GET /api/livechat/stream`. Requires a transport that implements
 * `subscribe` — Pusher does not (the browser connects to Pusher directly).
 *
 * Note: durable streaming needs a persistent Node runtime. On serverless
 * platforms with execution-time caps the connection is cut periodically, but
 * the browser's `EventSource` reconnects automatically.
 */
export async function handleStream(bridge: LiveChatBridge, req: Request): Promise<Response> {
  const channel = new URL(req.url).searchParams.get('channel');
  try {
    if (!channel) {
      throw new LiveChatBridgeError('BAD_REQUEST', 'Missing "channel" query parameter', 400);
    }
    await bridge.authorizeSubscription(req, channel);
  } catch (err) {
    return errorResponse(err);
  }

  const transport = bridge.config.transport;
  if (!isSubscribable(transport)) {
    return errorResponse(
      new LiveChatBridgeError(
        'STREAM_UNSUPPORTED',
        'The configured transport does not support SSE streaming. Use SSETransport.',
        500
      )
    );
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client disconnected mid-flush).
        }
      };

      // Advise the browser's reconnection delay, then open the stream.
      enqueue('retry: 3000\n: connected\n\n');

      const unsubscribe = transport.subscribe(channel, (event, payload) => {
        enqueue(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      });
      const keepAlive = setInterval(() => enqueue(': keep-alive\n\n'), KEEPALIVE_MS);

      cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      // Tear down when the client disconnects.
      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener('abort', () => cleanup?.(), { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable nginx proxy buffering so events flush immediately.
      'x-accel-buffering': 'no',
    },
  });
}
