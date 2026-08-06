import { fromFileUrl } from '@std/path'

// claude: resolved from this module's own URL rather than Deno.cwd(), so log files
// claude: always land in ./logs next to this file regardless of which task/cwd
// claude: invoked it (matters once this is imported by both sync.ts's own CLI entry
// claude: and cron.ts's long-running process).
const LOG_DIR = fromFileUrl(new URL('./logs/', import.meta.url))

let currentFile: Deno.FsFile | null = null
let currentPath: string | null = null
let depth = 0

const encoder = new TextEncoder()

// claude: cron.ts runs once a day and sync.ts's own CLI entry adds occasional extras
// claude: on top, so 30 days is roughly a month of history — enough to look back at a
// claude: past failure without the folder growing forever on an unattended box.
const LOG_RETENTION_DAYS = 30

function timestamp(): string {
  return new Date().toISOString()
}

// claude: runs once per fresh file (not on a nested startRun reuse) so a long-lived
// claude: process like cron.ts still gets pruning applied on each new day's run rather
// claude: than only at process startup.
function pruneOldLogs(): number {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let removed = 0
  for (const entry of Deno.readDirSync(LOG_DIR)) {
    if (!entry.isFile || !entry.name.endsWith('.log')) {
      continue
    }
    const path = `${LOG_DIR}${entry.name}`
    const { mtime } = Deno.statSync(path)
    if (mtime && mtime.getTime() < cutoff) {
      Deno.removeSync(path)
      removed++
    }
  }
  return removed
}

// claude: reference-counted so a nested call — cron.ts wraps the whole daily job in
// claude: one log file while sync.ts's own runSyncAndEmail wraps just the sync
// claude: portion of it — shares that one file instead of the inner startRun/endRun
// claude: pair closing it out from under the outer caller.
export function startRun(name: string): string {
  depth++
  if (currentFile && currentPath) {
    return currentPath
  }

  Deno.mkdirSync(LOG_DIR, { recursive: true })
  const removed = pruneOldLogs()

  const stamp = timestamp().replace(/[:.]/g, '-')
  currentPath = `${LOG_DIR}${name}-${stamp}.log`
  currentFile = Deno.openSync(currentPath, { create: true, write: true, append: true })
  if (removed > 0) {
    log(`logger.ts: pruned ${removed} log file(s) older than ${LOG_RETENTION_DAYS} days`)
  }
  return currentPath
}

export function endRun(): void {
  depth = Math.max(0, depth - 1)
  if (depth === 0 && currentFile) {
    currentFile.close()
    currentFile = null
    currentPath = null
  }
}

export function currentLogPath(): string | null {
  return currentPath
}

export function log(message: string): void {
  const line = `[${timestamp()}] ${message}`
  console.log(line)
  currentFile?.writeSync(encoder.encode(line + '\n'))
}

export function logError(message: string, error?: unknown): void {
  const detail = error
    ? `: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    : ''
  const line = `[${timestamp()}] ${message}${detail}`
  console.error(line)
  currentFile?.writeSync(encoder.encode(line + '\n'))
}
