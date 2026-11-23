/**
 * One-shot English-to-Chinese translation for approval reasons.
 *
 * Auto-review reasons (and some hook reasons) arrive in English. The QQ card is
 * Chinese, so an English reason is translated through the host's own model
 * routing (\`ctx.llm\`) before the card is rendered. This is deliberately a plain
 * one-shot completion: no tools, no session, no approval of its own — so it can
 * never recurse back into the approval waterfall it is serving.
 *
 * Failure is always soft: an unavailable model, a timeout, or an answer without
 * any Chinese falls back to the original text.
 *
 * dsh-llm is imported dynamically: the host provides it, but translation is an
 * enhancement and must never prevent the component (or the approval card) from
 * loading when that package is not resolvable.
 *
 * @module dsh-utils/approval-qq/translate
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
/** Minimal \`ctx.llm\` slice used here. */
export interface LlmRuntime {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** Resolved provider/model route for the translation call. */
export interface ModelRoute {
    provider: string;
    model: string;
}
/**
 * Whether a reason should be translated: it has real prose but no Chinese at
 * all. Text that already contains CJK is left untouched (mixed text is assumed
 * to be mostly Chinese), and very short or identifier-only strings are skipped.
 */
export declare function needsTranslation(text: string | undefined): boolean;
/** Best-effort translation; returns undefined so callers can fall back. */
export declare function translateToChinese(llm: LlmRuntime, route: ModelRoute, text: string, options: {
    timeoutMs: number;
    signal?: AbortSignal;
    maxChars?: number;
}): Promise<string | undefined>;
