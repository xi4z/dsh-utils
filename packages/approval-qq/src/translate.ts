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
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Minimal \`ctx.llm\` slice used here. */
export interface LlmRuntime {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Resolved provider/model route for the translation call. */
export interface ModelRoute {
  provider: string
  model: string
}

/** Translation instructions: translate prose, never touch identifiers or code. */
const SYSTEM_PROMPT = [
  'You translate approval reasons into Simplified Chinese.',
  'Keep tool names, commands, paths, identifiers and code verbatim.',
  'Do not add explanation, quotes, or markdown fences.',
  'Output only the translation.',
].join(' ')

let hostModule: Promise<typeof import('@deepseek-ai/dsh-llm') | undefined> | undefined

async function loadHostModule(): Promise<typeof import('@deepseek-ai/dsh-llm') | undefined> {
  hostModule ??= import('@deepseek-ai/dsh-llm').catch(() => undefined)
  return hostModule
}

/**
 * Whether a reason should be translated: it has real prose but no Chinese at
 * all. Text that already contains CJK is left untouched (mixed text is assumed
 * to be mostly Chinese), and very short or identifier-only strings are skipped.
 */
export function needsTranslation(text: string | undefined): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length < 8) return false
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(trimmed)) return false
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length
  return letters >= 8
}

/** Best-effort translation; returns undefined so callers can fall back. */
export async function translateToChinese(
  llm: LlmRuntime,
  route: ModelRoute,
  text: string,
  options: { timeoutMs: number; signal?: AbortSignal; maxChars?: number },
): Promise<string | undefined> {
  const source = text.trim().slice(0, options.maxChars ?? 1200)
  if (source === '') return undefined

  const host = await loadHostModule()
  if (host === undefined) return undefined

  const message = host.createUserMessage({
    content: [{ type: 'text', text: source }],
    source: { kind: 'user' },
  })
  const signals: AbortSignal[] = [AbortSignal.timeout(Math.max(200, options.timeoutMs))]
  if (options.signal) signals.push(options.signal)

  const assembler = new host.BlockAssembler()
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [message],
    system: SYSTEM_PROMPT,
    temperature: 0,
    maxTokens: 500,
    signal: AbortSignal.any(signals),
  })) {
    assembler.push(chunk)
  }

  const finish: FinishReason = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') return undefined

  const translated = assembler.blocks()
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim()
  if (translated === '') return undefined
  // A translation that produced no Chinese is not a translation; keep the source.
  if (!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(translated)) return undefined
  return translated
}
