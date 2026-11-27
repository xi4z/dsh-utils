/**
 * Direct-port sign-in for the `dsh-remote` row.
 *
 * The proxy half only sees traffic that came through the tunnel. The host's own
 * listener (the printed `127.0.0.1:3080`) is a second door, and it is the one an
 * operator hits when the tunnel is off or when the browser lost the startup URL:
 * DSH gates its index with a per-process launch token, exchanged once for a
 * signed `dsh-auth-*` cookie, and prints that tokenized URL a single time.
 *
 * This half closes that gap without weakening the gate. It wraps the Host's
 * `browserAuth.authorizeIndex()` and, for a GET/HEAD index request that carries
 * no valid cookie and no token, answers `303 Location: /?token=<launchToken>`
 * with the live token the Host already holds. The browser then walks the Host's
 * own exchange — token verified, cookie minted, `303` back to the clean `/` —
 * so nothing is forged, no credential is read, and the `dsh-auth-*` cookie stays
 * the Host's own.
 *
 * A request that already carries a token falls through untouched, so an invalid
 * one still ends in the Host's `401` instead of ping-ponging. A per-minute
 * redirect budget bounds a browser that refuses cookies: once spent, the Host's
 * own response is served and the row warns once.
 *
 * @module dsh-utils/remote/signin
 */
/** Volatile Config fields arrive as live references; `.get()` snapshots them. */
interface VolatileRef<T> {
    get(): T;
}
/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>;
/** The slice of an index request this module reads. */
export interface IndexRequestLike {
    readonly method?: string;
    readonly url?: string;
    readonly headers?: unknown;
}
/** The slice of the Host's index response this module writes to. */
export interface IndexResponseLike {
    writeHead(status: number, headers: Record<string, string>): void;
    end(body?: string): void;
}
/** The Host's browser-authentication owner, structurally. */
export interface BrowserAuthLike {
    readonly launchToken: string;
    isAuthenticated(request: IndexRequestLike, secure?: boolean): boolean;
    authorizeIndex(request: IndexRequestLike, response: IndexResponseLike, secure?: boolean): boolean;
}
/** The Host Connection service, structurally. */
export interface ConnectionLike {
    readonly browserAuth?: BrowserAuthLike;
}
/** The two config fields this half owns. */
export interface SignInConfig {
    readonly autoSignIn?: MaybeRef<boolean>;
    readonly signInMaxPerMinute?: MaybeRef<number>;
}
/** Just enough Cordis context to log and register a disposer. */
export interface SignInContext {
    readonly logger: {
        info(line: string): void;
        warn(line: string): void;
        error(line: string): void;
    };
    effect(factory: () => () => void, label: string): void;
}
/** Defaults, also used by the row's settings schema. */
export declare const SIGN_IN_DEFAULTS: {
    readonly autoSignIn: true;
    readonly signInMaxPerMinute: 30;
};
/**
 * Install the direct-port sign-in on the Host's auth owner.
 * @param ctx - the row's context; used for logging and the restore effect.
 * @param connection - the Host Connection service, when present.
 * @param config - the two sign-in fields; volatile references are snapshotted here.
 * @returns whether the wrapper is installed.
 */
export declare function installSignIn(ctx: SignInContext, connection: ConnectionLike | undefined, config?: SignInConfig): boolean;
export {};
