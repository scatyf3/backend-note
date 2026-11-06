/**
 * learn.config.ts 的类型和派生结构（纯函数，不依赖 node / DOM）。
 * 分层图、侧边栏、frontmatter 校验、闪卡牌组都从这里取。
 */

export interface Domain {
  /** docs/ 下的目录名 */
  dir: string
  label: string
  short: string
  color: string
  order: number
}

export interface StackTopic {
  /** 全站唯一，也是 docs/stack/<id>.md 的文件名 */
  id: string
  name: string
  /** 同层内的分组，图上用竖线隔开 */
  group?: string
}

export interface Layer {
  /** 层号，0 在最底 */
  id: number
  name: string
  /** 图上和中文名并排的英文名 */
  en: string
  short: string
  /** 一句话说明这层管什么 */
  scope: string
  /** 可选的小标签，比如「新增」 */
  tag?: string
  color: string
  topics: StackTopic[]
}

export interface StackDef {
  id: string
  name: string
  /** 图所在的页面；第一张图在首页 / */
  home: string
  /** 层号前缀，比如 L3、T3 */
  prefix: string
  /** 可选：图右侧的上下箭头 */
  rail?: { down: string; up: string }
  layers: Layer[]
}

export interface DeckDef {
  id: string
  label: string
  color: string
}

export interface LearnConfig {
  title: string
  description: string
  lang: string
  domains: Domain[]
  stacks: StackDef[]
  decks: DeckDef[]
}

/** 校验配置：id 重名、层号重复、空图都在这里拦下，构建和测试都会跑到 */
export function defineLearn(c: LearnConfig): LearnConfig {
  const fail = (m: string) => {
    throw new Error(`[learn.config] ${m}`)
  }
  if (!c.stacks.length) fail('至少要有一张分层图')
  const seen = new Set<string>()
  const stackIds = new Set<string>()
  for (const s of c.stacks) {
    if (stackIds.has(s.id)) fail(`分层图 id 重复：${s.id}`)
    stackIds.add(s.id)
    const layerIds = new Set<number>()
    for (const l of s.layers) {
      if (layerIds.has(l.id)) fail(`${s.id} 里层号重复：${l.id}`)
      layerIds.add(l.id)
      for (const t of l.topics) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) fail(`小主题 id 只能用小写字母、数字和 -：${t.id}`)
        if (/^(.+-)?layer-\d+$/.test(t.id)) fail(`小主题 id 不能长得像层 key：${t.id}`)
        if (seen.has(t.id)) fail(`小主题 id 重复：${t.id}`)
        seen.add(t.id)
      }
    }
  }
  const dirs = new Set<string>()
  for (const d of c.domains) {
    if (['stack', 'public'].includes(d.dir)) fail(`目录名 ${d.dir} 被占用`)
    if (dirs.has(d.dir)) fail(`目录重复：${d.dir}`)
    dirs.add(d.dir)
  }
  if (!c.decks.length) fail('至少要有一个闪卡牌组')
  return c
}

/** 第 i 张图第 n 层的 key：第一张图是 layer-N，其余是 <图 id>-layer-N */
export const layerKeyOf = (stacks: StackDef[], s: StackDef, n: number) =>
  s === stacks[0] ? `layer-${n}` : `${s.id}-layer-${n}`

export interface Located {
  stack: StackDef
  layer: Layer
  topic?: StackTopic
}

export function buildIndex(stacks: StackDef[]) {
  const byKey = new Map<string, Located>()
  for (const s of stacks) {
    for (const l of s.layers) {
      byKey.set(layerKeyOf(stacks, s, l.id), { stack: s, layer: l })
      for (const t of l.topics) byKey.set(t.id, { stack: s, layer: l, topic: t })
    }
  }
  /**
   * frontmatter `stack` 里的一项 → 格子 key。
   * 字符串：小主题 id 或层 key；数字：第一张图的第 N 层（兼容写法）。
   * 认不出来返回 undefined。
   */
  const normalize = (entry: string | number): string | undefined => {
    const key = typeof entry === 'number' ? layerKeyOf(stacks, stacks[0], entry) : entry
    return byKey.has(key) ? key : undefined
  }
  return { byKey, normalize }
}
