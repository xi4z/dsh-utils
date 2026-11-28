/**
 * Embedded (chrome-less) view for the `dsh-remote` row.
 *
 * `?embed=1` hides the Host's own sidebar so the conversation fills the frame;
 * `?embed=1&session=<id>` also selects that one Session by clicking its row.
 * Nothing here authenticates or proxies: the document is the Host's own.
 *
 * @module dsh-utils/remote/embed
 */
/** Marker id so a reload never stacks two copies. */
const STYLE_ID = 'dsh-utils-embed';
/** Hides every Host chrome surface an embedded view must not offer. */
export const EMBED_CSS = [
    '[class*="_frame"]{grid-template-columns:0px minmax(0px,1fr) 0px !important}',
    '[class*="_frame"]>div:first-child{display:none !important}',
    '[data-sidebar-toggle],[data-sidebar-list-area],[data-sidebar-workspace-header],',
    'nav[aria-label="Global panels"],[aria-label="New session"],[aria-label="Choose workspace"],',
    '[aria-label="Search sessions"],[aria-label="Add workspace"],[aria-label="More"],',
    '[aria-label="Account menu"]{display:none !important}',
].join('');
/**
 * Build the injected bootstrap: install the style, then optionally select one Session.
 * @param sessionId - the Session to force-select, or undefined to only hide chrome.
 * @returns the script body without a script wrapper.
 */
export function embedBootstrap(sessionId) {
    const want = JSON.stringify(sessionId ?? '');
    return [
        '(function(){',
        'var STYLE_ID=' + JSON.stringify(STYLE_ID) + ';',
        'var CSS=' + JSON.stringify(EMBED_CSS) + ';',
        'var hidden=false;',
        'function hide(){if(hidden)return;hidden=true;var old=document.getElementById(STYLE_ID);if(old)return;var s=document.createElement("style");s.id=STYLE_ID;s.textContent=CSS;(document.head||document.documentElement).appendChild(s)}',
        'var want=' + want + ';',
        'if(!want){hide();return}',
        'var candidates=["session:"+want,"session:session-"+want];',
        'function row(){for(var i=0;i<candidates.length;i++){var el=document.querySelector("[data-row-key=\""+candidates[i]+"\"]");if(el)return el}return null}',
        'function expand(){var rows=document.querySelectorAll("[data-row-key^=\"workspace:\"][aria-expanded=\"false\"]");for(var i=0;i<rows.length;i++){var ch=rows[i].querySelector("[class*=chevron]")||rows[i];try{ch.click()}catch(e){}}}',
        'var tick=0,clicks=0;',
        'var timer=setInterval(function(){',
        '  var hit=row();',
        '  var tree=document.querySelector(\'[data-row-key^="workspace:"]\');',
        '  if(!hit){',
        '    if(!tree){return}', // wait for the workspace tree before counting
        '    tick+=1;if(tick%3===0){expand()}if(tick>120){clearInterval(timer)}return',
        '  }',
        '  if(hit.getAttribute("aria-selected")==="true"){clearInterval(timer);hide();return}',
        '  var target=hit.querySelector("[class*=title]")||hit;try{target.click()}catch(e){}',
        '  clicks+=1;',
        '  if(clicks>8){clearInterval(timer)}',
        '},700)',
        '})()',
    ].join('');
}
/**
 * Inject the embed style and bootstrap into one HTML document.
 * @param html - the Host index document.
 * @param sessionId - optional Session to force-select.
 * @returns the document with the embed payload before the closing body tag.
 */
export function injectEmbed(html, sessionId) {
    const payload = '<style id="' + STYLE_ID + '">' + EMBED_CSS + '</style><script>' + embedBootstrap(sessionId) + '</script>';
    const at = html.toLowerCase().lastIndexOf('</body>');
    if (at >= 0)
        return html.slice(0, at) + payload + html.slice(at);
    return html + payload;
}
/**
 * Parse the embed request out of a query string.
 * @param search - the request URL search string.
 * @returns the request when embed=1 is present, else undefined.
 */
export function parseEmbed(search) {
    const params = new URLSearchParams(search);
    if (params.get('embed') !== '1')
        return undefined;
    const session = params.get('session');
    return session === null || session === '' ? {} : { session };
}
//# sourceMappingURL=embed.js.map