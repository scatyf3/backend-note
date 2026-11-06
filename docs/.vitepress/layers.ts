/**
 * 分层图：数据在根目录的 learn.config.ts，这里只做派生（按 id 查图、格子 key → 位置、文章 → 格子）。
 * 文章 frontmatter 的 `stack: [..]` 里每一项是小主题 id 或层 key（layer-N / <图 id>-layer-N），
 * 数字 N 等价于第一张图的 layer-N。
 */
import config from '../../learn.config'
import { buildIndex, layerKeyOf, type Layer, type StackDef as BaseStackDef, type StackTopic } from '../../src/lib/config'

export type { Layer, StackTopic }
export type StackId = string

export interface StackDef extends BaseStackDef {
  layerKey: (n: number) => string
}

export const stackList: StackDef[] = config.stacks.map((s) => ({ ...s, layerKey: (n: number) => layerKeyOf(config.stacks, s, n) }))
export const stacks: Record<StackId, StackDef> = Object.fromEntries(stackList.map((s) => [s.id, s]))
export const mainStack = stackList[0]

const { byKey, normalize } = buildIndex(config.stacks)
export { normalize as normalizeStackEntry }

/** 格子 key（小主题 id 或层 key）→ 它在哪张图、哪一层 */
export function locateKey(key: string): { stack: StackDef; layer: Layer; topic?: StackTopic } | undefined {
  const loc = byKey.get(key)
  return loc ? { ...loc, stack: stacks[loc.stack.id] } : undefined
}

/** 一篇文章挂在哪些格子上（frontmatter 已在 topics.data.ts 里校验过） */
export function keysOfArticle(t: { stack: (string | number)[] }): string[] {
  return t.stack.map((s) => normalize(s)!).filter(Boolean)
}
