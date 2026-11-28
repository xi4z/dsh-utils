/**
 * `dsh-utils` remote component: the Host half.
 *
 * The Harness Web server answers loopback only, and its `/api` fence accepts
 * nothing but loopback, its own bind address, or a configured `trustedHosts`
 * authority. Publishing the GUI through a tunnel therefore needs one local hop
 * that speaks the loopback authority, which is what this row provides:
 *
 *   browser -> operator tunnel -> 127.0.0.1:<listenPort> -> 127.0.0.1:<webServer.port>
 *
 * The proxy rewrites `Host`/`Origin`/`Referer`, relays HTTP, SSE and WebSocket
 * traffic, and — on a desktop profile — answers the first `401` on `GET /` with
 * the tokenized URL the Host itself minted, because the desktop shell never
 * prints a startup URL an operator could paste. Authentication is unchanged:
 * no credential is read, no cookie is forged, and the `dsh-auth-*` cookie stays
 * the Host's own.
 *
 * On a desktop profile the UI policy is `preserve-desktop-ui`: the document,
 * its client modules and the fallback seat are relayed untouched, so the stock
 * desktop UI is what a remote browser gets. A web profile defaults to
 * `passthrough`, where the operator already holds the printed startup URL.
 *
 * Security boundary: this row listens on loopback only by default. It is not an
 * authentication layer — the operator's tunnel, or the Host's own cookie, is.
 *
 * @module dsh-utils/remote
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Row name; the Loader mounts this package under `dsh-remote`. */
export declare const name = "dsh-remote";
/** The two Host services the row cannot work without. */
export declare const inject: string[];
/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
    get(): T;
}
/** One setting as the Loader supplies it: a live reference, or a plain value in tests. */
type MaybeRef<T> = T | VolatileRef<T>;
/** The runtime shape `apply` receives. */
export interface RemoteConfig {
    readonly enabled?: MaybeRef<boolean>;
    readonly listenHost?: MaybeRef<string>;
    readonly listenPort?: MaybeRef<number>;
    readonly publicUrl?: MaybeRef<string>;
    readonly strategy?: MaybeRef<string>;
    readonly autoBootstrap?: MaybeRef<boolean>;
    readonly allowRemoteListen?: MaybeRef<boolean>;
    readonly bootstrapMaxPerMinute?: MaybeRef<number>;
    readonly logAuthCookie?: MaybeRef<boolean>;
    readonly autoSignIn?: MaybeRef<boolean>;
    readonly signInMaxPerMinute?: MaybeRef<number>;
}
/**
 * Settings-page schema. Authentication inputs are volatile: the proxy re-reads
 * them on every request, so saving a public URL applies without a restart.
 * The listener address is read once at activation — changing it needs a reload.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    listenHost: z<string, string, "defined">;
    listenPort: z<number, number, "defined">;
    publicUrl: z<string, string, "volatile-defined">;
    strategy: z<"preserve-desktop-ui" | "passthrough" | "auto", "preserve-desktop-ui" | "passthrough" | "auto", "volatile-defined">;
    autoBootstrap: z<boolean, boolean, "volatile-defined">;
    allowRemoteListen: z<boolean, boolean, "defined">;
    bootstrapMaxPerMinute: z<number, number, "volatile-defined">;
    logAuthCookie: z<boolean, boolean, "volatile-defined">;
    autoSignIn: z<boolean, boolean, "volatile-defined">;
    signInMaxPerMinute: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    listenHost: z<string, string, "defined">;
    listenPort: z<number, number, "defined">;
    publicUrl: z<string, string, "volatile-defined">;
    strategy: z<"preserve-desktop-ui" | "passthrough" | "auto", "preserve-desktop-ui" | "passthrough" | "auto", "volatile-defined">;
    autoBootstrap: z<boolean, boolean, "volatile-defined">;
    allowRemoteListen: z<boolean, boolean, "defined">;
    bootstrapMaxPerMinute: z<number, number, "volatile-defined">;
    logAuthCookie: z<boolean, boolean, "volatile-defined">;
    autoSignIn: z<boolean, boolean, "volatile-defined">;
    signInMaxPerMinute: z<number, number, "volatile-defined">;
}>>, "plain">;
/**
 * Activate the proxy.
 * @param ctx - host Cordis context.
 * @param config - row config; volatile fields arrive as live references.
 */
export declare function apply(ctx: Context, config?: RemoteConfig): void;
export {};
