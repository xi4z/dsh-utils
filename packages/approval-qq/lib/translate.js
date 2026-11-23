/** Translation instructions: translate prose, never touch identifiers or code. */
const SYSTEM_PROMPT = [
    'You translate approval reasons into Simplified Chinese.',
    'Keep tool names, commands, paths, identifiers and code verbatim.',
    'Do not add explanation, quotes, or markdown fences.',
    'Output only the translation.',
].join(' ');
let hostModule;
async function loadHostModule() {
    hostModule ??= import('@deepseek-ai/dsh-llm').catch(() => undefined);
    return hostModule;
}
/**
 * Whether a reason should be translated: it has real prose but no Chinese at
 * all. Text that already contains CJK is left untouched (mixed text is assumed
 * to be mostly Chinese), and very short or identifier-only strings are skipped.
 */
export function needsTranslation(text) {
    if (typeof text !== 'string')
        return false;
    const trimmed = text.trim();
    if (trimmed.length < 8)
        return false;
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(trimmed))
        return false;
    const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
    return letters >= 8;
}
/** Best-effort translation; returns undefined so callers can fall back. */
export async function translateToChinese(llm, route, text, options) {
    const source = text.trim().slice(0, options.maxChars ?? 1200);
    if (source === '')
        return undefined;
    const host = await loadHostModule();
    if (host === undefined)
        return undefined;
    const message = host.createUserMessage({
        content: [{ type: 'text', text: source }],
        source: { kind: 'user' },
    });
    const signals = [AbortSignal.timeout(Math.max(200, options.timeoutMs))];
    if (options.signal)
        signals.push(options.signal);
    const assembler = new host.BlockAssembler();
    for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [message],
        system: SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 500,
        signal: AbortSignal.any(signals),
    })) {
        assembler.push(chunk);
    }
    const finish = assembler.finish;
    if (finish.kind === 'error' || finish.kind === 'aborted')
        return undefined;
    const translated = assembler.blocks()
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .trim();
    if (translated === '')
        return undefined;
    // A translation that produced no Chinese is not a translation; keep the source.
    if (!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(translated))
        return undefined;
    return translated;
}
//# sourceMappingURL=translate.js.map