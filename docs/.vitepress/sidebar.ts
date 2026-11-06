import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import type { DefaultTheme } from 'vitepress'
import { domains } from './domains'
import { locateKey, normalizeStackEntry, stackList } from './layers'

const docsRoot = fileURLToPath(new URL('..', import.meta.url))

interface Entry {
  key: string
  dir: string
  title: string
  order: number
  stack: (string | number)[]
}

function readDomain(dir: string): Entry[] {
  const abs = path.join(docsRoot, dir)
  if (!fs.existsSync(abs)) return []
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .map((f) => {
      const key = `${dir}/${f.replace(/\.md$/, '')}`
      const fm = matter(fs.readFileSync(path.join(abs, f), 'utf8')).data
      return { key, dir, title: fm.title ?? key, order: fm.order ?? 99, stack: Array.isArray(fm.stack) ? fm.stack : [] }
    })
}

/**
 * 侧边栏：按分层图的层分组（文章归 frontmatter `stack` 第一项所在的层），
 * 没挂到图上的文章按目录分组。空组不显示。
 */
export function buildSidebar(): DefaultTheme.Sidebar {
  const domainRank = new Map(domains.map((d) => [d.dir, d.order]))
  const entries = domains.flatMap((d) => readDomain(d.dir))
  const groups = new Map<string, Entry[]>()
  const push = (g: string, e: Entry) => groups.set(g, [...(groups.get(g) ?? []), e])

  for (const e of entries) {
    const first = e.stack.length ? normalizeStackEntry(e.stack[0]) : undefined
    const loc = first ? locateKey(first) : undefined
    push(loc ? loc.stack.layerKey(loc.layer.id) : `dir:${e.dir}`, e)
  }

  const sort = (es: Entry[]) =>
    es.sort((a, b) => (domainRank.get(a.dir) ?? 99) - (domainRank.get(b.dir) ?? 99) || a.order - b.order || a.key.localeCompare(b.key))
  const item = (e: Entry) => ({ text: e.title, link: `/${e.key}` })

  const layerGroups = stackList.flatMap((s) =>
    s.layers.map((l) => {
      const key = s.layerKey(l.id)
      const label = stackList.length > 1 ? `${s.prefix}${l.id} ${l.name}（${s.name}）` : `${s.prefix}${l.id} ${l.name}`
      return { text: label, link: `/stack/${key}`, collapsed: false, items: sort(groups.get(key) ?? []).map(item) }
    }),
  )
  const dirGroups = domains.map((d) => ({
    text: d.label,
    link: fs.existsSync(path.join(docsRoot, d.dir, 'index.md')) ? `/${d.dir}/` : undefined,
    collapsed: false,
    items: sort(groups.get(`dir:${d.dir}`) ?? []).map(item),
  }))
  return [...layerGroups, ...dirGroups].filter((g) => g.items.length)
}
