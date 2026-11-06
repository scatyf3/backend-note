/**
 * 学一个新东西时唯一要改的文件：站点标题、笔记目录、分层图、闪卡牌组。
 *
 * 仓库名 / GitHub Pages 的 base / 闪卡同步的 data 分支都不用填，
 * 构建时从 GITHUB_REPOSITORY（Actions）或 `git remote get-url origin`（本地）推出来。
 *
 * 改完跑 `npm run scaffold`：给每层、每个小主题补上 docs/stack/<id>.md 占位页，给每个目录补 index.md。
 */
import { defineLearn } from './src/lib/config.ts'

export default defineLearn({
  title: 'Learn Stack',
  description: '分层知识库：分层图 + 每格一篇笔记 + 闪卡复习',
  lang: 'zh-CN',

  /** 笔记目录：docs/<dir>/*.md。颜色用在分层图面板和侧边栏 */
  domains: [
    { dir: 'notes', label: '笔记', short: '笔记', color: '#3b82f6', order: 1 },
  ],

  /**
   * 分层图。第一张图画在首页，其余各占一页（home）。
   * 层从下往上编号，0 是最底层的地基；每层拆 3–5 个小主题。
   * 小主题 id 全站唯一，文章用 frontmatter `stack: [<小主题 id> | <层 key>]` 挂上来。
   * 层 key：第一张图是 layer-N，其余图是 <图 id>-layer-N。
   */
  stacks: [
    {
      id: 'main',
      name: '主线',
      home: '/',
      prefix: 'L',
      // 可选：图右侧的上下箭头（比如 request ↓ / response ↑）；不要就删掉
      rail: { down: 'input', up: 'output' },
      layers: [
        {
          id: 0, name: '地基', en: 'Foundations', short: '地基', color: '#0ea5e9',
          scope: '其他层都依赖的东西',
          topics: [
            { id: 'f-a', name: '概念 A' },
            { id: 'f-b', name: '概念 B' },
          ],
        },
        {
          id: 1, name: '机制', en: 'Mechanisms', short: '机制', color: '#22c55e',
          scope: '核心机制怎么运作',
          topics: [
            { id: 'm-a', name: '机制 A', group: '一组' },
            { id: 'm-b', name: '机制 B', group: '一组' },
            { id: 'm-c', name: '机制 C', group: '另一组' },
          ],
        },
        {
          id: 2, name: '应用', en: 'Applications', short: '应用', color: '#f97316',
          scope: '组合起来解决实际问题',
          topics: [
            { id: 'a-a', name: '应用 A' },
            { id: 'a-b', name: '应用 B' },
          ],
        },
      ],
    },
  ],

  /** 闪卡牌组：卡片在 src/data/flashcards.ts */
  decks: [
    { id: 'core', label: '核心', color: '#0e7490' },
  ],
})
