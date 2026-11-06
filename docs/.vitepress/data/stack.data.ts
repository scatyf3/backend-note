import { createContentLoader } from 'vitepress'
import config from '../../../learn.config'
import { buildIndex } from '../../../src/lib/config'

const { byKey } = buildIndex(config.stacks)

/**
 * docs/stack/<id>.md：分层图里每个格子的基础介绍，构建时渲染成 HTML 供首页面板直接展示。
 * id 是小主题 id，或层 key（layer-N / <图 id>-layer-N）表示那一层的总述。
 */
export interface StackIntro {
  id: string
  title: string
  url: string
  /** 去掉了页面 h1 的正文 HTML */
  html: string
}

declare const data: StackIntro[]
export { data }

export default createContentLoader('stack/*.md', {
  render: true,
  transform(raw): StackIntro[] {
    return raw.map((p) => {
      const id = p.url.split('/').filter(Boolean)[1]
      if (!byKey.has(id)) throw new Error(`[stack] docs/stack/${id}.md 不对应 learn.config.ts 里任何一层或小主题（改了 id 就把文件也改名）`)
      return {
        id,
        title: p.frontmatter.title ?? id,
        url: p.url,
        html: (p.html ?? '').replace(/^\s*<h1[\s\S]*?<\/h1>/, '').trim(),
      }
    })
  },
})
