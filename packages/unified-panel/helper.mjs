// dsh-session-summary helper v3: list + live state + pending approval from the store only.
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const CACHE_DIR = join(process.env.UNIFIED_CACHE_DIR || join(process.env.HOME || '.', '.dsh', '.unified'))
const CACHE_FILE = join(CACHE_DIR, 'cache.json')
function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) } catch { return {} }
}
function saveCache(c) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify(c)) } catch {}
}
const cache = loadCache()
const nextCache = {}

const root = process.argv[2]
const RECENT_MS = Number(process.env.UNIFIED_RECENT_MS || 6 * 3600 * 1000)

function headSummary(file) {
  return new Promise(resolve => {
    const p = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = '', header = null, title = null, done = false
    const finish = () => { if (done) return; done = true; try { p.kill('SIGKILL') } catch {} ; resolve({ header, title }) }
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', c => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let j; try { j = JSON.parse(line) } catch { continue }
        if (j.type === 'session') header = j
        else if (j.type === 'session/title' && j.data && j.data.title) { title = j.data.title; return finish() }
      }
      if (header && title) finish()
      if (buf.length > 1_000_000) finish()
    })
    p.on('exit', finish); p.on('error', finish)
    setTimeout(finish, 5000).unref()
  })
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function tailEvents(file, size, frames = 3) {
  let collected = ''
  let end = size
  for (let n = 0; n < frames && end > 0; n++) {
    const win = Math.min(end, 192 * 1024)
    const buf = Buffer.alloc(win)
    const fd = openSync(file, 'r'); readSync(fd, buf, 0, win, end - win); closeSync(fd)
    let cut = -1
    for (let i = buf.length - 4; i >= 0; i--) if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) { cut = i; break }
    if (cut < 0) break
    const fed = buf.subarray(cut)
    const out = spawnSync('zstd', ['-dc'], { input: fed, maxBuffer: 32 * 1024 * 1024 })
    if (out.status !== 0) break
    collected = out.stdout.toString('utf8') + collected
    end = end - win + cut
  }
  return collected
}

function liveState(file, size) {
  const text = tailEvents(file, size, Number(process.env.UNIFIED_FRAMES || 12))
  const events = []
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const j = JSON.parse(line); if (j.type !== 'session' && j.type !== 'session/title') events.push(j) } catch {} }
  let lastTurnStart = -1, lastTurnEnd = -1
  const asked = new Map(); const decided = new Set(); let lastTool = ''
  for (const e of events) {
    const seq = typeof e.seq === 'number' ? e.seq : -1
    if (e.type === 'turn/start') lastTurnStart = Math.max(lastTurnStart, seq)
    else if (e.type === 'turn/end') lastTurnEnd = Math.max(lastTurnEnd, seq)
    else if (e.type === 'approval/asked' && e.data && e.data.id) asked.set(e.data.id, e.data)
    else if (e.type === 'approval/decided' && e.data) decided.add(e.data.id || e.data.requestId)
    else if (e.type === 'tool/call' && e.data) lastTool = e.data.name || ''
  }
  const pending = [...asked.values()].filter(a => !decided.has(a.id))
  const lastType = events.length ? events[events.length - 1].type : ''
  const fresh = (Date.now() - statSync(file).mtimeMs) < 15 * 60 * 1000
  const terminal = lastType === 'turn/end' || lastType === 'session/end' || lastType === ''
  const running = lastTurnStart > lastTurnEnd || (fresh && !terminal)
  return {
    state: pending.length ? 'approval' : running ? 'running' : 'idle',
    lastType: events.length ? events[events.length - 1].type : '',
    approval: pending.length ? { tool: pending[0].toolName || '', reason: (pending[0].reason || '').slice(0, 160) } : null,
    tool: pending.length ? (pending[0].toolName || '') : lastTool,
  }
}

const out = []
const now = Date.now()
const projects = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : []
for (const proj of projects) {
  let ids = []
  try { ids = readdirSync(join(root, proj), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { continue }
  for (const id of ids) {
    const sdir = join(root, proj, id)
    let files = []
    try { files = readdirSync(sdir).filter(f => /^session.*\.jsonl\.zstd$/.test(f)) } catch { continue }
    if (!files.length) continue
    files.sort()
    const file = join(sdir, files[files.length - 1])
    let st; try { st = statSync(file) } catch { continue }
    const key = file + ':' + Math.round(st.mtimeMs) + ':' + st.size
    const hit = cache[key]
    let summary, live
    if (hit) { summary = hit.summary; live = hit.live }
    else {
      summary = await headSummary(file)
      live = (now - st.mtimeMs) < RECENT_MS
        ? liveState(file, st.size)
        : { state: 'idle', lastType: '', approval: null, tool: '' }
      nextCache[key] = { summary, live }
    }
    const { header, title } = summary
    out.push({
      host: process.env.UNIFIED_HOST || 'local',
      project: proj.replace(/^--/, '').replace(/--$/, '').replace(/--/g, '/'),
      cwd: (header && header.cwd) || '',
      id, mtime: st.mtimeMs,
      title: title || (header && header.cwd) || '',
      origin: (header && header.origin) || 'user',
      state: live.state, lastType: live.lastType, approval: live.approval, tool: live.tool,
    })
  }
}
saveCache(nextCache)
process.stdout.write(out.map(o => JSON.stringify(o)).join('\n') + '\n')
