/**
 * `dsh-utils` remote component: the proxy half.
 *
 * The Harness Web server refuses any authority it was not configured to serve:
 * `/api` compares `Host` against loopback, the listener's own bind address, or
 * `configured trustedHosts`, and an attached `Origin` must name that same
 * authority. A tunnel that preserves the public hostname therefore gets 403
 * from every privileged call, while one that rewrites it gets an `Origin`
 * mismatch. Either way the browser holds no cookie whose audience matches.
 *
 * This proxy sits between the operator's tunnel and the loopback listener:
 *
 * - it rewrites `Host`, `Origin` and `Referer` to the loopback authority, so
 *   the upstream fence accepts the call and mints/validates the cookie for that
 *   same audience;
 * - it never touches the document, the client modules or the fallback seat, so
 *   a desktop profile keeps its stock UI;
 * - when the Host answers `401` to `GET /`, it redirects once per window to the
 *   tokenized URL the Host itself minted (`connection.authenticatedUrl`), so a
 *   remote browser can complete the exchange a desktop Host never prints.
 *
 * Authentication stays exactly where it was: the proxy holds no credential,
 * forges no cookie, and cannot authenticate anything by itself.
 *
 * @module dsh-utils/remote/proxy
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { injectEmbed, parseEmbed } from './embed.js';
/** Loopback-only introspection route on the proxy's own port. */
export const STATUS_PATH = '/_dsh_utils_remote/status';
/** One bootstrap window per peer, in milliseconds. */
const BOOTSTRAP_WINDOW_MS = 60_000;
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
/** `host:port`, bracketing an IPv6 literal so it can be a URL authority. */
export function formatAuthority(host, port) {
    return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}
/** Whether an address can only be reached from this machine. */
export function isLoopbackHost(host) {
    const bare = host.replace(/^\[|\]$/gu, '').toLowerCase();
    if (bare === 'localhost' || bare === '::1' || bare === '')
        return bare !== '';
    if (bare.startsWith('127.'))
        return true;
    return bare.startsWith('::ffff:127.');
}
/**
 * Validate the operator's public root: absolute `http(s)`, no userinfo, query,
 * fragment or surrounding whitespace, path ending in `/`.
 * @param value - configured public URL.
 * @returns the normalized target, or undefined when unusable.
 */
export function normalizePublicUrl(value) {
    const text = value.trim();
    if (text === '')
        return undefined;
    if (/[\u0000-\u0020\u007f]/u.test(text))
        return undefined;
    let url;
    try {
        url = new URL(text);
    }
    catch {
        return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return undefined;
    if (url.username !== '' || url.password !== '')
        return undefined;
    if (url.search !== '' || url.hash !== '')
        return undefined;
    if (!url.pathname.endsWith('/'))
        url.pathname += '/';
    return { origin: url.origin, href: url.href };
}
/**
 * Rewrite the browser-facing authority to the loopback one, so the upstream
 * fence and the cookie audience agree.
 * @param headers - incoming request headers.
 * @param upstream - loopback target.
 * @param upgrade - keep the upgrade handshake headers.
 * @returns headers safe to send upstream.
 */
export function rewriteRequestHeaders(headers, upstream, upgrade = false) {
    const authority = formatAuthority(upstream.host, upstream.port);
    const base = `${upstream.protocol}//${authority}`;
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined)
            continue;
        const name = key.toLowerCase();
        if (name === 'host')
            continue;
        if (name.startsWith('x-forwarded-') || name === 'forwarded')
            continue;
        if (!upgrade && HOP_BY_HOP.has(name))
            continue;
        if (upgrade && name !== 'connection' && name !== 'upgrade' && HOP_BY_HOP.has(name))
            continue;
        out[name] = value;
    }
    out.host = authority;
    if (typeof out.origin === 'string')
        out.origin = base;
    if (typeof out.referer === 'string')
        out.referer = rebaseUrl(out.referer, base);
    return out;
}
/**
 * Move one absolute URL onto the loopback base, preserving path and query.
 */
export function rebaseUrl(value, base) {
    try {
        const url = new URL(value);
        return `${base}${url.pathname}${url.search}${url.hash}`;
    }
    catch {
        return `${base}/`;
    }
}
/**
 * Rewrite an upstream `Location` that names the loopback authority, so a
 * redirect never sends the browser to its own machine.
 * @param location - upstream header value.
 * @param upstreamBase - upstream origin such as `http://127.0.0.1:3080`.
 * @param publicOrigin - public origin to substitute.
 * @returns the header value to send downstream.
 */
export function rewriteLocation(location, upstreamBase, publicOrigin) {
    if (publicOrigin === '')
        return location;
    if (location === upstreamBase)
        return publicOrigin;
    if (location.startsWith(`${upstreamBase}/`))
        return `${publicOrigin}${location.slice(upstreamBase.length)}`;
    return location;
}
/**
 * Whether an unauthenticated index response should be answered with the Host's
 * own tokenized URL. Bounded per peer so a rejected cookie cannot ping-pong.
 * @param input - request facts and the live settings.
 * @returns true when the proxy may redirect instead of relaying the 401.
 */
export function shouldBootstrap(input) {
    if (input.method !== 'GET')
        return false;
    if (input.pathname !== '/')
        return false;
    if (input.hasToken)
        return false;
    if (input.upstreamStatus !== 401)
        return false;
    const settings = input.settings;
    if (settings.strategy !== 'preserve-desktop-ui' || !settings.autoBootstrap)
        return false;
    if (settings.publicUrl === '')
        return false;
    return input.recentBootstraps < settings.bootstrapMaxPerMinute;
}
/** Copy the upstream response headers, dropping hop-by-hop framing. */
function responseHeaders(source) {
    const out = {};
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined)
            continue;
        const name = key.toLowerCase();
        if (name === 'transfer-encoding' || name === 'connection' || name === 'keep-alive')
            continue;
        out[name] = value;
    }
    return out;
}
/**
 * Create the proxy. Activation calls {@link ProxyHandle.start}; disposal calls
 * {@link ProxyHandle.close}.
 * @param options - listener, upstream, live settings and the tokenized-URL seam.
 * @returns the handle.
 */
export function createProxy(options) {
    const stats = { requests: 0, proxied: 0, bootstrapped: 0, upgrades: 0, refused: 0 };
    const boots = new Map();
    const now = options.now ?? Date.now;
    const isLoopbackPeer = options.isLoopbackPeer ?? ((address) => address === undefined || isLoopbackHost(address));
    /** Origin of one upstream resolution, used for redirect rewriting. */
    const baseOf = (upstream) => `${upstream.protocol}//${formatAuthority(upstream.host, upstream.port)}`;
    /** Cookies already echoed, so a re-exchanged session is not spammed. */
    const echoed = new Set();
    let server;
    let address;
    /** Every accepted socket, including upgraded ones `closeAllConnections()` skips. */
    const sockets = new Set();
    /** Bootstraps recorded for one peer inside the current window. */
    const recentBootstraps = (peer) => {
        const entry = boots.get(peer);
        if (entry === undefined)
            return 0;
        if (now() - entry.window >= BOOTSTRAP_WINDOW_MS) {
            boots.delete(peer);
            return 0;
        }
        return entry.count;
    };
    const recordBootstrap = (peer) => {
        const entry = boots.get(peer);
        if (entry === undefined || now() - entry.window >= BOOTSTRAP_WINDOW_MS) {
            boots.set(peer, { window: now(), count: 1 });
            return;
        }
        entry.count += 1;
    };
    /**
     * Echo the session cookie the Host just minted. The value is a live
     * credential: it is logged because the operator asked for it and the Host log
     * is local, never sent to the browser or to a tunnel.
     */
    const echoCookies = (headers, peer) => {
        if (!options.settings().logAuthCookie)
            return;
        const raw = headers['set-cookie'];
        if (raw === undefined)
            return;
        const entries = Array.isArray(raw) ? raw : [raw];
        for (const entry of entries) {
            if (!entry.startsWith('dsh-auth-'))
                continue;
            const value = entry.split(';', 1)[0]?.trim() ?? '';
            if (value === '' || echoed.has(value))
                continue;
            if (echoed.size >= 256) {
                const oldest = echoed.values().next().value;
                if (oldest !== undefined)
                    echoed.delete(oldest);
            }
            echoed.add(value);
            options.logger.info(`dsh-remote: auth cookie minted for ${peer}: ${entry}`);
        }
    };
    const tokenizedUrl = (settings) => {
        try {
            const url = options.authenticatedUrl(settings.publicUrl);
            return typeof url === 'string' && url !== '' ? url : undefined;
        }
        catch (error) {
            options.logger.warn(`dsh-remote: cannot mint the startup URL: ${String(error)}`);
            return undefined;
        }
    };
    const respondStatus = (request, response) => {
        if (!isLoopbackPeer(request.socket.remoteAddress)) {
            stats.refused += 1;
            response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('loopback only\n');
            return;
        }
        let upstream = 'unresolved';
        try {
            upstream = baseOf(options.upstream());
        }
        catch {
            // The Host may be between starts; report the last known value.
        }
        const body = JSON.stringify({
            ...options.describe?.(),
            upstream,
            listen: address,
            stats,
        }, null, 2);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(body);
    };
    const relay = (request, response) => {
        const settings = options.settings();
        const target = normalizePublicUrl(settings.publicUrl);
        const url = new URL(request.url ?? '/', 'http://proxy.invalid');
        stats.requests += 1;
        const peer = request.socket.remoteAddress ?? 'unknown';
        let upstream;
        try {
            upstream = options.upstream();
        }
        catch (error) {
            options.logger.warn(`dsh-remote: upstream is not ready: ${String(error)}`);
            response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            response.end('dsh-remote: upstream is not ready\n');
            return;
        }
        const upstreamBase = baseOf(upstream);
        const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
        const embed = parseEmbed(url.search);
        const requestHeaders = rewriteRequestHeaders(request.headers, upstream);
        if (embed !== undefined)
            delete requestHeaders['accept-encoding'];
        const outgoing = transport({
            host: upstream.host,
            port: upstream.port,
            method: request.method,
            path: request.url,
            headers: requestHeaders,
            agent: false,
        });
        outgoing.on('response', (upstreamResponse) => {
            const recent = recentBootstraps(peer);
            echoCookies(upstreamResponse.headers, peer);
            const headers = responseHeaders(upstreamResponse.headers);
            if (typeof upstreamResponse.headers.location === 'string') {
                headers.location = rewriteLocation(upstreamResponse.headers.location, upstreamBase, target?.origin ?? '');
            }
            const bootstrap = shouldBootstrap({
                method: request.method,
                pathname: url.pathname,
                hasToken: url.searchParams.has('token'),
                upstreamStatus: upstreamResponse.statusCode ?? 0,
                settings,
                recentBootstraps: recent,
            });
            const location = bootstrap ? tokenizedUrl(settings) : undefined;
            if (location !== undefined) {
                stats.bootstrapped += 1;
                recordBootstrap(peer);
                upstreamResponse.resume();
                response.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
                response.end();
                return;
            }
            if (embed !== undefined && String(upstreamResponse.headers['content-type'] ?? '').startsWith('text/html')) {
                const chunks = [];
                upstreamResponse.on('data', (chunk) => chunks.push(chunk));
                upstreamResponse.on('end', () => {
                    const body = Buffer.from(injectEmbed(Buffer.concat(chunks).toString('utf8'), embed.session), 'utf8');
                    delete headers['content-encoding'];
                    headers['content-length'] = String(body.length);
                    stats.proxied += 1;
                    response.writeHead(upstreamResponse.statusCode ?? 200, upstreamResponse.statusMessage, headers);
                    response.end(body);
                });
                return;
            }
            stats.proxied += 1;
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
            upstreamResponse.pipe(response);
        });
        outgoing.on('error', (error) => {
            options.logger.warn(`dsh-remote: upstream error for ${request.url ?? '/'}: ${String(error)}`);
            if (!response.headersSent) {
                response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
                response.end('dsh-remote: upstream unavailable\n');
            }
            else {
                response.destroy();
            }
        });
        request.on('aborted', () => outgoing.destroy());
        request.pipe(outgoing);
    };
    const relayUpgrade = (request, socket, head) => {
        stats.upgrades += 1;
        let upstream;
        try {
            upstream = options.upstream();
        }
        catch (error) {
            options.logger.warn(`dsh-remote: upstream is not ready for the upgrade: ${String(error)}`);
            socket.destroy();
            return;
        }
        const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
        const outgoing = transport({
            host: upstream.host,
            port: upstream.port,
            method: request.method,
            path: request.url,
            headers: rewriteRequestHeaders(request.headers, upstream, true),
            agent: false,
        });
        outgoing.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
            if (!socket.writable) {
                upstreamSocket.destroy();
                return;
            }
            const lines = ['HTTP/1.1 101 Switching Protocols'];
            for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
                lines.push(`${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`);
            }
            socket.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (upstreamHead.length > 0)
                socket.write(upstreamHead);
            if (head.length > 0)
                upstreamSocket.write(head);
            upstreamSocket.on('error', () => socket.destroy());
            socket.on('error', () => upstreamSocket.destroy());
            socket.on('close', () => upstreamSocket.destroy());
            upstreamSocket.on('close', () => socket.destroy());
            upstreamSocket.pipe(socket);
            socket.pipe(upstreamSocket);
        });
        outgoing.on('response', (upstreamResponse) => {
            const headers = responseHeaders(upstreamResponse.headers);
            const lines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? ''}`];
            for (const [name, value] of Object.entries(headers)) {
                if (Array.isArray(value)) {
                    for (const item of value)
                        lines.push(`${name}: ${item}`);
                }
                else if (value !== undefined) {
                    lines.push(`${name}: ${value}`);
                }
            }
            socket.write(`${lines.join('\r\n')}\r\n\r\n`);
            upstreamResponse.pipe(socket);
        });
        outgoing.on('error', () => {
            stats.refused += 1;
            socket.destroy();
        });
        outgoing.end();
    };
    const dispatch = (request, response) => {
        const url = new URL(request.url ?? '/', 'http://proxy.invalid');
        if (url.pathname === STATUS_PATH) {
            respondStatus(request, response);
            return;
        }
        relay(request, response);
    };
    return {
        stats,
        address: () => address,
        start: async () => {
            const created = createServer(dispatch);
            created.on('connection', (socket) => {
                sockets.add(socket);
                socket.on('close', () => sockets.delete(socket));
            });
            created.on('upgrade', (request, socket, head) => {
                const url = new URL(request.url ?? '/', 'http://proxy.invalid');
                if (url.pathname === STATUS_PATH) {
                    stats.refused += 1;
                    socket.destroy();
                    return;
                }
                relayUpgrade(request, socket, head);
            });
            created.on('clientError', (_error, socket) => {
                try {
                    socket.destroy();
                }
                catch {
                    // The socket may already be gone.
                }
            });
            await new Promise((resolve, reject) => {
                const onError = (error) => reject(error);
                created.once('error', onError);
                created.listen(options.listenPort, options.listenHost, () => {
                    created.off('error', onError);
                    created.on('error', (error) => options.logger.error(`dsh-remote: listener error: ${String(error)}`));
                    resolve();
                });
            });
            const bound = created.address();
            if (bound === null || typeof bound === 'string') {
                created.close();
                throw new Error('dsh-remote: listener did not report a TCP address');
            }
            address = { host: bound.address, port: bound.port };
            server = created;
            return address;
        },
        close: async () => {
            const current = server;
            server = undefined;
            address = undefined;
            if (current === undefined)
                return;
            await new Promise((resolve) => {
                const finish = () => resolve();
                current.close(finish);
                current.closeAllConnections();
                for (const socket of sockets)
                    socket.destroy();
                sockets.clear();
                // Never hang disposal on a socket Node does not account for.
                setTimeout(finish, 1_000).unref();
            });
        },
    };
}
//# sourceMappingURL=proxy.js.map