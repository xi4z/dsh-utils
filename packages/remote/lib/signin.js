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
/** Defaults, also used by the row's settings schema. */
export const SIGN_IN_DEFAULTS = {
    autoSignIn: true,
    signInMaxPerMinute: 30,
};
/** Marker set on the patched prototype, so reloads stay idempotent. */
const PATCHED = Symbol.for('dsh-utils.remote.signin');
/** Snapshot one setting, resolving a volatile reference. */
function read(value, fallback) {
    if (value === undefined)
        return fallback;
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/** Sliding one-minute budget for redirects this process has sent. */
function createBudget(limit) {
    const window = 60_000;
    let stamps = [];
    return {
        admit(now) {
            stamps = stamps.filter((stamp) => now - stamp < window);
            if (stamps.length >= limit)
                return false;
            stamps.push(now);
            return true;
        },
    };
}
/**
 * Install the direct-port sign-in on the Host's auth owner.
 * @param ctx - the row's context; used for logging and the restore effect.
 * @param connection - the Host Connection service, when present.
 * @param config - the two sign-in fields; volatile references are snapshotted here.
 * @returns whether the wrapper is installed.
 */
export function installSignIn(ctx, connection, config = {}) {
    const logger = ctx.logger;
    if (read(config.autoSignIn, SIGN_IN_DEFAULTS.autoSignIn) !== true) {
        logger.info('dsh-remote: autoSignIn is off; the printed ?token= URL is required for the direct port');
        return false;
    }
    const auth = connection?.browserAuth;
    const prototype = auth === undefined ? undefined : Object.getPrototypeOf(auth);
    if (prototype === undefined
        || typeof prototype.authorizeIndex !== 'function'
        || typeof prototype.isAuthenticated !== 'function'
        || typeof auth?.launchToken !== 'string'
        || auth.launchToken === '') {
        logger.warn('dsh-remote: connection.browserAuth.authorizeIndex()/launchToken is unavailable on this Host; '
            + 'direct-port sign-in stays off (reopen the ?token= URL printed by dsh web)');
        return false;
    }
    if (prototype[PATCHED] === true)
        return true;
    const original = prototype.authorizeIndex;
    const budget = createBudget(read(config.signInMaxPerMinute, SIGN_IN_DEFAULTS.signInMaxPerMinute));
    let budgetWarned = false;
    prototype.authorizeIndex = function authorizeIndex(request, response, secure = false) {
        const indexRequest = request.method === 'GET' || request.method === 'HEAD';
        if (indexRequest && !this.isAuthenticated(request, secure)) {
            const url = new URL(request.url ?? '/', 'http://dsh.invalid');
            // A request that already carries a token falls through: an invalid one
            // must reach the Host's 401 instead of bouncing back here.
            if (!url.searchParams.has('token')) {
                if (!budget.admit(Date.now())) {
                    if (!budgetWarned) {
                        budgetWarned = true;
                        logger.warn('dsh-remote: sign-in redirect budget exhausted (the browser is not keeping the dsh-auth cookie); '
                            + 'serving the Host 401 until the window clears');
                    }
                    return original.call(this, request, response, secure);
                }
                response.writeHead(303, {
                    'cache-control': 'no-store',
                    location: `${url.pathname}?token=${encodeURIComponent(this.launchToken)}`,
                    'referrer-policy': 'no-referrer',
                });
                response.end();
                return false;
            }
        }
        return original.call(this, request, response, secure);
    };
    Object.defineProperty(prototype, PATCHED, { value: true, configurable: true, writable: true, enumerable: false });
    ctx.effect(() => () => {
        if (prototype[PATCHED] !== true)
            return;
        prototype.authorizeIndex = original;
        delete prototype[PATCHED];
    }, 'dsh-remote: direct-port sign-in');
    logger.info('dsh-remote: direct-port sign-in on — a cookie-less index request is answered with the Host\'s own '
        + `launch-token URL (budget ${read(config.signInMaxPerMinute, SIGN_IN_DEFAULTS.signInMaxPerMinute)}/min)`);
    return true;
}
//# sourceMappingURL=signin.js.map