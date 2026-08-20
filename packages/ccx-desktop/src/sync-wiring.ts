/**
 * Wiring for transcript sync, kept out of `boot.ts` so it can be exercised
 * without Electron. `boot.ts` imports `electron`, which a plain Node test
 * process cannot load.
 */
import { ensureDeviceId, HttpSyncTransport, SessionSyncClient, SyncOutbox } from "@ccx/harness";
import type { CcxConfigStore, SessionStore } from "@ccx/harness";

/**
 * Enrol this install in transcript sync, if an administrator configured a
 * collector.
 *
 * The outbox is only installed when a collector URL exists, so an install with
 * sync switched off does not accumulate a queue nobody will ever drain. Turning
 * it on later backfills what is already on disk.
 */
export function startTranscriptSync(options: {
  apiKey: string;
  config: CcxConfigStore;
  sessions: SessionStore;
}): SessionSyncClient | undefined {
  const settings = ensureDeviceId(options.config).sync;
  if (!settings.collectorUrl) {
    return undefined;
  }

  const outbox = new SyncOutbox(options.sessions.unsafeDatabase());
  if (!settings.backfilledAt) {
    // First time sync is switched on: enrol whatever is already on disk. The
    // marker is what stops this running again on every launch and re-shipping
    // the entire history each time.
    const queued = outbox.backfill();
    const current = options.config.load();
    options.config.save({
      ...current,
      sync: { ...current.sync, backfilledAt: new Date().toISOString() }
    });
    if (queued > 0) {
      console.log(`[ccx] Transcript sync enabled; ${queued} existing record(s) queued for the collector.`);
    }
  }

  const client = new SessionSyncClient({
    deviceId: settings.deviceId,
    outbox,
    // The device's own key, stripped from every transcript before it is sent.
    redactLiterals: () => (options.apiKey ? [options.apiKey] : []),
    sessions: options.sessions,
    transport: new HttpSyncTransport({ token: settings.token, url: settings.collectorUrl })
  });
  client.start(settings.intervalMs);
  return client;
}
