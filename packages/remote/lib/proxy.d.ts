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
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
/** Where the proxied requests go: the loopback Harness listener. */
export interface Upstream {
    readonly host: string;
    readonly port: number;
    readonly protocol: 'http:' | 'https:';
}
/** Live settings, re-read on every request so a saved change applies at once. */
export interface RemoteSettings {
    readonly publicUrl: string;
    readonly strategy: 'preserve-desktop-ui' | 'passthrough';
    readonly autoBootstrap: boolean;
    readonly bootstrapMaxPerMinute: number;
    /** Echo a freshly minted `dsh-auth-*` cookie into the Host log. */
    readonly logAuthCookie: boolean;
}
/** Counters exposed by the status route. */
export interface ProxyStats {
    requests: number;
    proxied: number;
    bootstrapped: number;
    upgrades: number;
    refused: number;
}
/** Everything the proxy needs, injected so the module stays testable. */
export interface ProxyOptions {
    readonly listenHost: string;
    readonly listenPort: number;
    /** Resolved per request: the desktop Host picks a new port on every start. */
    readonly upstream: () => Upstream;
    readonly settings: () => RemoteSettings;
    /** Host-side tokenized URL for the configured public root. */
    readonly authenticatedUrl: (baseUrl: string) => string;
    readonly logger: {
        info(line: string): void;
        warn(line: string): void;
        error(line: string): void;
    };
    /** Describe the composition for the status route. */
    readonly describe?: () => Readonly<Record<string, unknown>>;
    /** Clock used for the bootstrap window; tests pin it. */
    readonly now?: () => number;
    readonly isLoopbackPeer?: (address: string | undefined) => boolean;
}
/** The started listener. */
export interface ProxyHandle {
    readonly stats: ProxyStats;
    start(): Promise<{
        readonly host: string;
        readonly port: number;
    }>;
    close(): Promise<void>;
    address(): {
        readonly host: string;
        readonly port: number;
    } | undefined;
}
/** Loopback-only introspection route on the proxy's own port. */
export declare const STATUS_PATH = "/_dsh_utils_remote/status";
/** `host:port`, bracketing an IPv6 literal so it can be a URL authority. */
export declare function formatAuthority(host: string, port: number): string;
/** Whether an address can only be reached from this machine. */
export declare function isLoopbackHost(host: string): boolean;
/** A validated public root and its origin. */
export interface PublicTarget {
    readonly origin: string;
    readonly href: string;
}
/**
 * Validate the operator's public root: absolute `http(s)`, no userinfo, query,
 * fragment or surrounding whitespace, path ending in `/`.
 * @param value - configured public URL.
 * @returns the normalized target, or undefined when unusable.
 */
export declare function normalizePublicUrl(value: string): PublicTarget | undefined;
/**
 * Rewrite the browser-facing authority to the loopback one, so the upstream
 * fence and the cookie audience agree.
 * @param headers - incoming request headers.
 * @param upstream - loopback target.
 * @param upgrade - keep the upgrade handshake headers.
 * @returns headers safe to send upstream.
 */
export declare function rewriteRequestHeaders(headers: IncomingHttpHeaders, upstream: Upstream, upgrade?: boolean): OutgoingHttpHeaders;
/**
 * Move one absolute URL onto the loopback base, preserving path and query.
 */
export declare function rebaseUrl(value: string, base: string): string;
/**
 * Rewrite an upstream `Location` that names the loopback authority, so a
 * redirect never sends the browser to its own machine.
 * @param location - upstream header value.
 * @param upstreamBase - upstream origin such as `http://127.0.0.1:3080`.
 * @param publicOrigin - public origin to substitute.
 * @returns the header value to send downstream.
 */
export declare function rewriteLocation(location: string, upstreamBase: string, publicOrigin: string): string;
/** Inputs of the one redirect this proxy is allowed to make on its own. */
export interface BootstrapInput {
    readonly method: string | undefined;
    readonly pathname: string;
    readonly hasToken: boolean;
    readonly upstreamStatus: number;
    readonly settings: RemoteSettings;
    readonly recentBootstraps: number;
}
/**
 * Whether an unauthenticated index response should be answered with the Host's
 * own tokenized URL. Bounded per peer so a rejected cookie cannot ping-pong.
 * @param input - request facts and the live settings.
 * @returns true when the proxy may redirect instead of relaying the 401.
 */
export declare function shouldBootstrap(input: BootstrapInput): boolean;
/**
 * Create the proxy. Activation calls {@link ProxyHandle.start}; disposal calls
 * {@link ProxyHandle.close}.
 * @param options - listener, upstream, live settings and the tokenized-URL seam.
 * @returns the handle.
 */
export declare function createProxy(options: ProxyOptions): ProxyHandle;
