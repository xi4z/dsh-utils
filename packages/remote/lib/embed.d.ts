/**
 * Embedded (chrome-less) view for the `dsh-remote` row.
 *
 * `?embed=1` hides the Host's own sidebar so the conversation fills the frame;
 * `?embed=1&session=<id>` also selects that one Session by clicking its row.
 * Nothing here authenticates or proxies: the document is the Host's own.
 *
 * @module dsh-utils/remote/embed
 */
/** Hides every Host chrome surface an embedded view must not offer. */
export declare const EMBED_CSS: string;
/**
 * Build the injected bootstrap: install the style, then optionally select one Session.
 * @param sessionId - the Session to force-select, or undefined to only hide chrome.
 * @returns the script body without a script wrapper.
 */
export declare function embedBootstrap(sessionId?: string): string;
/**
 * Inject the embed style and bootstrap into one HTML document.
 * @param html - the Host index document.
 * @param sessionId - optional Session to force-select.
 * @returns the document with the embed payload before the closing body tag.
 */
export declare function injectEmbed(html: string, sessionId?: string): string;
/**
 * Parse the embed request out of a query string.
 * @param search - the request URL search string.
 * @returns the request when embed=1 is present, else undefined.
 */
export declare function parseEmbed(search: string): {
    readonly session?: string;
} | undefined;
