/**
 * dsh-utils-unified-panel — show every device's recent DSH sessions inside the
 * web GUI as native Workspace entries.
 *
 * Host half: serves GET /api/unified/sessions from the same SSH aggregation the
 * standalone CLI uses, and POST /api/unified/decide for approvals through each
 * device's approval bridge. The browser half injects the remote rows into the
 * client's session/workspace stores; nothing here signs the page in.
 *
 * @module dsh-utils/unified-panel
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-utils-unified-panel'

const HERE = dirname(fileURLToPath(import.meta.url))

/** One peer machine as configured in peers.json. */
export interface PanelPeer {
  name?: string
  transport?: 'ssh' | 'local'
  target?: string
  dshHome?: string
  bridge?: { port?: number; token?: string }
  web?: { url?: string }
}

/** Row configuration; peers win over the peers file when both are present. */
export interface PanelConfig {
  peers?: PanelPeer[]
  peersFile?: string
}

interface SessionRow {
  host?: string
  project?: string
  cwd?: string
  id: string
  mtime: number
  title?: string
  origin?: string
  state?: string
  lastType?: string
  approval?: { tool?: string; reason?: string } | null
  tool?: string
  web?: string
  local?: boolean
  bridgeId?: string
}

interface PendingApproval { id: string; sessionId: string; tool?: string; reason?: string }

function peers(config: PanelConfig): PanelPeer[] {
  if (Array.isArray(config?.peers) && config.peers.length > 0) return config.peers
  const file = config?.peersFile || join(HERE, '..', 'peers.json')
  if (!existsSync(file)) return []
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { peers?: PanelPeer[] }).peers ?? []
  } catch {
    return []
  }
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function bridgeCurl(peer: PanelPeer, path: string, body?: unknown): unknown {
  const bridge = peer.bridge ?? {}
  if (bridge.port === undefined) return null
  const url = 'http://127.0.0.1:' + bridge.port + path
  const args = ['-s', '--max-time', '6', '-H', 'x-bridge-token: ' + (bridge.token ?? ''), url]
  if (body !== undefined) args.push('--data', JSON.stringify(body), '-H', 'content-type: application/json')
  try {
    const out = peer.transport === 'ssh'
      ? sh('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', peer.target ?? '', 'curl ' + args.map((arg) => JSON.stringify(arg)).join(' ')])
      : sh('curl', args)
    return JSON.parse(out || 'null') as unknown
  } catch {
    return null
  }
}

export function apply(ctx: Context, config: PanelConfig = {}): void {
  const helper = join(HERE, '..', 'helper.mjs')

  const list = (): { rows: SessionRow[]; errors: string[] } => {
    const rows: SessionRow[] = []
    const errors: string[] = []
    for (const peer of peers(config)) {
      try {
        if (peer.transport === 'ssh') {
          const encoded = Buffer.from(readFileSync(helper, 'utf8')).toString('base64')
          const remote = "mkdir -p ~/.dsh/.unified && printf %s '" + encoded + "' | base64 -d > ~/.dsh/.unified/helper.mjs && UNIFIED_HOST='" + (peer.name ?? peer.target ?? '') + "' node ~/.dsh/.unified/helper.mjs ~/.dsh/sessions"
          const out = sh('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', peer.target ?? '', remote])
          for (const line of out.split('\n')) {
            if (!line.trim()) continue
            try {
              const row = JSON.parse(line) as SessionRow
              if (peer.web?.url !== undefined) row.web = peer.web.url
              row.local = false
              rows.push(row)
            } catch {}
          }
        } else {
          const root = join((peer.dshHome || '~/.dsh').replace(/^~/, homedir()), 'sessions')
          const out = sh(process.execPath, [helper, root])
          for (const line of out.split('\n')) {
            if (!line.trim()) continue
            try {
              const row = JSON.parse(line) as SessionRow
              if (peer.web?.url !== undefined) row.web = peer.web.url
              row.local = true
              rows.push(row)
            } catch {}
          }
        }
      } catch (error) {
        errors.push((peer.name ?? peer.target ?? '?') + ': ' + String((error as Error).message).split('\n')[0])
      }
    }
    for (const peer of peers(config)) {
      const pending = (bridgeCurl(peer, '/pending') as PendingApproval[] | null) ?? []
      for (const approval of pending) {
        const row = rows.find((candidate) => candidate.id === approval.sessionId)
        if (row === undefined) continue
        row.state = 'approval'
        row.bridgeId = approval.id
        row.approval = { tool: approval.tool, reason: approval.reason }
        row.host = row.host ?? peer.name
      }
    }
    const rank = (row: SessionRow): number => (row.state === 'approval' ? 0 : row.state === 'running' ? 1 : 2)
    rows.sort((left, right) => rank(left) - rank(right) || right.mtime - left.mtime)
    return { rows: rows.filter((row) => row.mtime >= Date.now() - 7 * 864e5).slice(0, 60), errors }
  }

  const readBody = (req: { on: (event: string, listener: (chunk?: unknown) => void) => void; destroy: () => void }): Promise<string> =>
    new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk) => { body += String(chunk); if (body.length > 65536) req.destroy() })
      req.on('end', () => resolve(body))
    })

  ctx.on('connection/request' as never, ((req: any, res: any, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/api/unified/')) return next()
    if (req.method === 'GET' && url.pathname === '/api/unified/sessions') {
      const body = JSON.stringify(list())
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      return res.end(body)
    }
    if (req.method === 'POST' && url.pathname === '/api/unified/decide') {
      void readBody(req).then((raw) => {
        try {
          const request = JSON.parse(raw || '{}') as { peer?: string; id?: string; decision?: string }
          const peer = peers(config).find((candidate) => (candidate.name ?? candidate.target) === request.peer)
          if (peer === undefined) {
            res.writeHead(400)
            return res.end(JSON.stringify({ error: 'unknown peer' }))
          }
          const out = bridgeCurl(peer, '/decide', { id: request.id, decision: request.decision })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(out ?? { error: 'bridge unreachable' }))
        } catch (error) {
          res.writeHead(500)
          res.end(JSON.stringify({ error: String((error as Error).message) }))
        }
      })
      return
    }
    res.writeHead(404)
    res.end('{}')
  }) as never)
}
