import { createContentLoader } from 'vitepress'
// data loader 在 vite 别名之外单独打包，这里只能走相对路径
import config from '../../../learn.config'
import { buildIndex } from '../../../src/lib/config'

const { normalize } = buildIndex(config.stacks)
const DOMAINS = new Set(config.domains.map((d) => d.dir))
/** 第二张及以后的分层图各自的首页（如 /tools/），只放图，不算笔记 */
const STACK_HOMES = new Set(config.stacks.slice(1).map((s) => `/${s.home.replace(/^\/|\/$/g, '')}/`))

export type Status = 'todo' | 'draft' | 'reviewed'
export const STATUSES: Status[] = ['todo', 'draft', 'reviewed']

export interface Topic {
  url: string
  domain: string
  slug: string
  title: string
  status: Status
  tags: string[]
  difficulty: number
  related: string[]
  order: number
  isIndex: boolean
  /** 挂在分层图的哪些位置：小主题 id 或层 key（数字 = 第一张图的层号） */
  stack: (string | number)[]
}

declare const data: Topic[]
export { data }

export default createContentLoader('*/*.md', {
  transform(raw): Topic[] {
    return raw
      // docs/stack/ 是分层图格子的介绍页，由 stack.data.ts 收集，不算笔记
      .filter((p) => !p.url.startsWith('/stack/') && !STACK_HOMES.has(p.url))
      .map((p) => {
        const parts = p.url.split('/').filter(Boolean)
        const domain = parts[0]
        const slug = parts[1] ?? 'index'
        const isIndex = slug === 'index'
        const fm = p.frontmatter
        if (!DOMAINS.has(domain)) {
          throw new Error(`[topics] ${p.url} 所在的目录 ${domain} 没在 learn.config.ts 的 domains 里登记`)
        }
        const status: Status = fm.status ?? 'todo'
        if (!isIndex && !STATUSES.includes(status)) {
          throw new Error(`[topics] invalid status "${status}" in ${p.url} (expected ${STATUSES.join(' | ')})`)
        }
        if (!fm.title) throw new Error(`[topics] missing title in ${p.url}`)
        const stack: (string | number)[] = fm.stack ?? []
        for (const s of stack) {
          if (!normalize(s)) throw new Error(`[topics] unknown stack entry "${s}" in ${p.url}（应为 learn.config.ts 里的小主题 id 或 layer-N）`)
        }
        return {
          url: p.url,
          domain,
          slug,
          title: fm.title,
          status,
          tags: fm.tags ?? [],
          difficulty: fm.difficulty ?? 2,
          related: fm.related ?? [],
          order: fm.order ?? 99,
          isIndex,
          stack,
        }
      })
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.order - b.order || a.slug.localeCompare(b.slug))
  },
})
