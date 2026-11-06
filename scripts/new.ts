/**
 * npm run new -- <目录>/<文件名> "标题" [格子 id ...]
 *   例：npm run new -- notes/paged-attention "PagedAttention" kv-paged layer-4
 * 从 templates/note.md 建一篇笔记，frontmatter 的 stack 预填好。目录要在 learn.config.ts 的 domains 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import config from '../learn.config.ts'
import { buildIndex } from '../src/lib/config.ts'

const [target, title, ...keys] = process.argv.slice(2).filter((a) => a !== '--')
const fail = (m: string) => {
  console.error(m)
  process.exit(1)
}
if (!target || !title) fail('用法：npm run new -- <目录>/<文件名> "标题" [格子 id ...]')

const [dir, slug] = target.replace(/\.md$/, '').split('/')
if (!slug) fail(`路径要写成 <目录>/<文件名>，收到 ${target}`)
if (!config.domains.some((d) => d.dir === dir)) fail(`目录 ${dir} 没在 learn.config.ts 的 domains 里：${config.domains.map((d) => d.dir).join(', ')}`)

const { normalize } = buildIndex(config.stacks)
for (const k of keys) if (!normalize(k)) fail(`格子 ${k} 不在 learn.config.ts 里`)

const file = path.resolve(__dirname, '..', 'docs', dir, `${slug}.md`)
if (fs.existsSync(file)) fail(`已存在：docs/${dir}/${slug}.md`)
const body = fs
  .readFileSync(path.resolve(__dirname, '..', 'templates', 'note.md'), 'utf8')
  .replace('__TITLE__', title)
  .replace('__STACK__', keys.join(', '))
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, body)
console.log(`docs/${dir}/${slug}.md`)
