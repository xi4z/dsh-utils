/**
 * Which dsh surface hosts this row, and which UI policy that implies.
 *
 * The desktop shell runs the same Web application inside Electron's Node mode
 * (`apps/desktop`). Two facts about it drive this component:
 *
 * - It prints no startup URL: the launch token never reaches an operator, so a
 *   browser arriving through a tunnel cannot exchange it. Only the Host itself
 *   can mint the cookie, through `connection.authenticatedUrl`.
 * - Its window is the packaged client, so the document served over the proxy
 *   must stay stock. No HTML rewriting, no injected client module, no replaced
 *   fallback seat — that is the `preserve-desktop-ui` policy.
 *
 * Detection is ordered and conservative. A wrong guess degrades to
 * `passthrough`, which still proxies but never redirects by itself.
 *
 * @module dsh-utils/remote/detect
 */
const PROFILE_FLAG = /--profile[=\s]+["']?desktop\b/u;
const PROFILE_DIR = /(?:^|[\\/])profiles[\\/]desktop(?:[\\/]|$)/u;
const WEB_DIR = /(?:^|[\\/])profiles[\\/]web(?:[\\/]|$)/u;
/**
 * Classify the Host surface from the strongest available signal.
 * @param signals - Electron version, argv, environment and mounted services.
 * @returns the profile and the signal that decided it.
 */
export function detectProfile(signals = {}) {
    if (typeof signals.electron === 'string' && signals.electron !== '') {
        return { profile: 'desktop', reason: 'electron' };
    }
    const declared = signals.env?.DSH_PROFILE;
    if (declared === 'desktop' || declared === 'web') {
        return { profile: declared, reason: 'env' };
    }
    const argv = (signals.argv ?? []).join(' ');
    if (PROFILE_FLAG.test(argv) || PROFILE_DIR.test(argv)) {
        return { profile: 'desktop', reason: 'argv' };
    }
    if (WEB_DIR.test(argv)) {
        return { profile: 'web', reason: 'argv' };
    }
    if (signals.desktopService === true) {
        return { profile: 'desktop', reason: 'service' };
    }
    return { profile: 'unknown', reason: 'no-signal' };
}
/**
 * Pick the effective UI strategy.
 *
 * `auto` keeps a detected desktop on `preserve-desktop-ui` (the Host must
 * bootstrap the cookie it never printed). An unknown profile only auto-enables
 * that behaviour when a public URL is configured — without one there is nothing
 * to bootstrap towards.
 * @param input - configured strategy.
 * @param context - detected profile and configured public URL.
 * @returns the strategy and the rule that chose it.
 */
export function resolveStrategy(input, context) {
    if (input === 'preserve-desktop-ui' || input === 'passthrough') {
        return { strategy: input, reason: 'config' };
    }
    if (context.profile === 'desktop')
        return { strategy: 'preserve-desktop-ui', reason: 'desktop' };
    if (context.profile === 'web')
        return { strategy: 'passthrough', reason: 'web' };
    return context.publicUrl === ''
        ? { strategy: 'passthrough', reason: 'unknown-no-public-url' }
        : { strategy: 'preserve-desktop-ui', reason: 'unknown-with-public-url' };
}
/** Coerce an arbitrary configured string into a known strategy input. */
export function normalizeStrategyInput(value) {
    return value === 'preserve-desktop-ui' || value === 'passthrough' ? value : 'auto';
}
//# sourceMappingURL=detect.js.map