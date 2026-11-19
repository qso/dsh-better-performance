import z from '@deepseek-ai/schemastery';
export const Config = z.object({
  maxSessions: z.number().step(1).min(0).max(8).default(3),
  retainMinutes: z.number().step(1).min(1).max(30).default(5),
  pollMs: z.number().step(1).min(200).max(5000).default(500),
  binaryPollMs: z.number().step(1).min(200).max(10000).default(1000),
  idleWatchMs: z.number().step(1).min(0).max(10000).default(1500),
  macWatch: z.boolean().default(true),
  earlyDirectoryReads: z.boolean().default(true),
  previewIntent: z.boolean().default(true),
  fastBytes: z.boolean().default(true),
});
// Expose only the configured display limits to this desktop's browser module.
import { localWatch } from './watch-service.js';
export const inject = ['fs', 'workspaceFiles', 'attachments'];
export function apply(ctx, options = {}) {
  const integer = (key, fallback, min, max) => Number.isInteger(options[key])
    ? Math.min(max, Math.max(min, options[key])) : fallback;
  const settings = {
    maxSessions: integer('maxSessions', 3, 0, 8),
    retainMinutes: integer('retainMinutes', 5, 1, 30),
    earlyDirectoryReads: options.earlyDirectoryReads !== false,
    previewIntent: options.previewIntent !== false,
    fastBytes: options.fastBytes !== false,
    pollMs: integer('pollMs', 500, 200, 5000),
    binaryPollMs: integer('binaryPollMs', 1000, 200, 10000),
    idleWatchMs: integer('idleWatchMs', 1500, 0, 10000),
  };
  let active = false;
  ctx.effect(() => {
    const stop = options.macWatch !== false && localWatch(ctx, settings);
    active = Boolean(stop);
    return stop || undefined;
  }, 'afterburn: isolated macOS filesystem observer');
  ctx.on('webserver/index-inject', table => {
    table.push({kind:'global',name:'__DSH_AFTERBURN_CONFIG__',value:settings});
    table.push({kind:'global',name:'__DSH_AFTERBURN_WATCH_WORKER__',value:active});
    const fileCap = ctx.workspaceFiles.config?.maxFileBytes;
    const mediaCap = ctx.attachments.imageLimits?.maxImageBytes;
    if (!settings.fastBytes || !Number.isSafeInteger(fileCap) || !Number.isSafeInteger(mediaCap)) return;
    table.push({ kind: 'global', name: '__DSH_AFTERBURN_PREVIEW_BYTES__', value: Math.min(fileCap, mediaCap) });
  });
}
