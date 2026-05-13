import { EventEmitter } from 'node:events';

/** Single-process in-memory fanout for chat events.
 *
 *  Keys are opaque strings — `room:<slug>` for room messages, `dm:<thread_id>`
 *  for DM threads (when slice 4 lands). Subscribers receive every event
 *  published on their key. Block-list filtering happens in the route layer,
 *  not the hub.
 *
 *  Process-local: a multi-worker cluster won't fan out across workers. That's
 *  acceptable at launch traffic; cross-worker via Postgres LISTEN/NOTIFY or
 *  Redis pub/sub is a slice-N upgrade if we need it. */

export interface ChatEvent {
  /** SSE event name (e.g. 'room_message', 'room_message_deleted'). */
  event: string;
  /** Resumable ID (DB row id for messages) or synthetic id for non-resumable events. */
  id: string;
  /** Pre-serialized payload — written verbatim into the SSE `data:` line. */
  data: string;
}

const emitter = new EventEmitter();
// Default 10 listeners is too low — a single popular room could have thousands
// of subscribers. We don't realistically hit 10k per room at launch, but raise
// the cap so node doesn't print warnings.
emitter.setMaxListeners(10_000);

export function publish(key: string, evt: ChatEvent): void {
  emitter.emit(key, evt);
}

export function subscribe(key: string, handler: (evt: ChatEvent) => void): () => void {
  emitter.on(key, handler);
  return () => emitter.off(key, handler);
}
