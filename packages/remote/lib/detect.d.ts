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
/** The surface that mounted this row. */
export type ProfileKind = 'desktop' | 'web' | 'unknown';
/** What the proxy does about authentication when a page is not authorized yet. */
export type UiStrategy = 'preserve-desktop-ui' | 'passthrough';
/** Configured strategy: `auto` resolves from the detected profile. */
export type StrategyInput = 'auto' | UiStrategy;
/** Signals read once at activation; all optional so tests can pin one at a time. */
export interface ProfileSignals {
    /** `process.versions.electron` — present for the Electron Node-mode Host. */
    readonly electron?: string | undefined;
    /** `process.argv` of the Host process. */
    readonly argv?: readonly string[];
    /** Environment of the Host process. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Whether the desktop Host's own service is mounted on the context. */
    readonly desktopService?: boolean;
}
/** One detection result plus the signal that decided it. */
export interface ProfileDecision {
    readonly profile: ProfileKind;
    readonly reason: string;
}
/**
 * Classify the Host surface from the strongest available signal.
 * @param signals - Electron version, argv, environment and mounted services.
 * @returns the profile and the signal that decided it.
 */
export declare function detectProfile(signals?: ProfileSignals): ProfileDecision;
/** Strategy resolution inputs: configured value, detected profile, public URL. */
export interface StrategyContext {
    readonly profile: ProfileKind;
    readonly publicUrl: string;
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
export declare function resolveStrategy(input: StrategyInput, context: StrategyContext): {
    readonly strategy: UiStrategy;
    readonly reason: string;
};
/** Coerce an arbitrary configured string into a known strategy input. */
export declare function normalizeStrategyInput(value: string | undefined): StrategyInput;
