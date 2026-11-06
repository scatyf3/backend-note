/**
 * npm run scaffold：按 learn.config.ts 补齐占位文件，已有的文件一律不动。
 *   - docs/stack/<小主题 id>.md、docs/stack/<层 key>.md
 *   - docs/<目录>/index.md
 *   - 第二张及以后的分层图：它的 home 页（放一张 <StackFigure stack="id" />）
 * 也会列出 docs/stack/ 里对不上配置的旧文件（改了 id 之后留下的），提示手动改名或删掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import config from '../learn.config.ts'
import { buildIndex, layerKeyOf } from '../src/lib/config.ts'

const root = path.resolve(__dirname, '..')
const docs = path.join(root, 'docs')
const tpl = (name: string) => fs.readFileSync(path.join(root, 'templates', name), 'utf8')
const created: string[] = []

function write(rel: string, body: string) {
  const abs = path.join(docs, rel)
  if (fs.existsSync(abs)) return
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  created.push(rel)
}

for (const s of config.stacks) {
  for (const l of s.layers) {
    const key = layerKeyOf(config.stacks, s, l.id)
    write(
      `stack/${key}.md`,
      tpl('stack-layer.md')
        .replaceAll('__N__', String(l.id))
        .replaceAll('__NAME__', l.name)
        .replace('__TOPICS__', l.topics.map((t) => `- **${t.name}**：`).join('\n')),
    )
    for (const t of l.topics) {
      write(`stack/${t.id}.md`, tpl('stack-topic.md').replaceAll('__TITLE__', t.name).replaceAll('__ID__', t.id))
    }
  }
  if (s !== config.stacks[0]) {
    const home = s.home.replace(/^\/|\/$/g, '')
    write(`${home}/index.md`, `---\ntitle: ${s.name}\n---\n\n# ${s.name}\n\n<StackFigure stack="${s.id}" />\n`)
  }
}

for (const d of config.domains) {
  write(`${d.dir}/index.md`, `---\ntitle: ${d.label}\n---\n\n# ${d.label}\n`)
}

const { byKey } = buildIndex(config.stacks)
const stale = fs.existsSync(path.join(docs, 'stack'))
  ? fs.readdirSync(path.join(docs, 'stack')).filter((f) => f.endsWith('.md') && !byKey.has(f.slice(0, -3)))
  : []

console.log(created.length ? `新建 ${created.length} 个文件：\n${created.map((f) => `  docs/${f}`).join('\n')}` : '没有要补的文件')
if (stale.length) {
  console.log(`\n这些文件对不上 learn.config.ts 里的任何格子，构建会失败，请改名或删掉：\n${stale.map((f) => `  docs/stack/${f}`).join('\n')}`)
  process.exitCode = 1
}
