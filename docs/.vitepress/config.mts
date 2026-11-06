import { defineConfig } from 'vitepress'
import { fileURLToPath } from 'node:url'
import learn from '../../learn.config'
import { buildSidebar } from './sidebar'
import { markPlugin } from './markdown/mark'
import { dataStore } from './dataStore'
import { baseOf, detectRepo } from './repo.node'
import { domains } from './domains'
import { stackList } from './layers'

const REPO = detectRepo()
const BASE = baseOf(REPO)
const REPO_URL = `https://github.com/${REPO.owner}/${REPO.name}`

export default defineConfig({
  lang: learn.lang,
  title: learn.title,
  description: learn.description,
  base: BASE,
  // 手机上「添加到主屏幕」后像 app 一样全屏打开、离线可用（manifest 由下面的 transformHead 按配置生成）
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${BASE}icons/favicon-64.png` }],
    ['link', { rel: 'manifest', href: `${BASE}manifest.webmanifest` }],
    ['link', { rel: 'apple-touch-icon', href: `${BASE}icons/apple-touch-icon.png` }],
    ['meta', { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#1b1b1f', media: '(prefers-color-scheme: dark)' }],
    ['meta', { name: 'mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'apple-mobile-web-app-title', content: learn.title }],
    ['meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }],
  ],
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  markdown: {
    math: true,
    lineNumbers: false,
    config: (md) => {
      md.use(markPlugin)
    },
  },
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      ...stackList.slice(1).map((s) => ({ text: s.name, link: s.home })),
      ...domains.map((d) => ({ text: d.short, link: `/${d.dir}/` })),
      { text: '闪卡', link: '/flashcards' },
    ],
    sidebar: buildSidebar(),
    search: { provider: 'local', options: { detailedView: true } },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    socialLinks: [{ icon: 'github', link: REPO_URL }],
    editLink: { pattern: `${REPO_URL}/edit/main/docs/:path`, text: '在 GitHub 上编辑' },
  },
  vite: {
    define: { __LEARN_REPO__: JSON.stringify(REPO) },
    plugins: [dataStore(), manifest()],
    resolve: {
      alias: {
        '@lib': fileURLToPath(new URL('../../src/lib', import.meta.url)),
        '@data': fileURLToPath(new URL('../../src/data', import.meta.url)),
      },
    },
  },
})

/** PWA manifest 按站点标题和 base 生成：dev 下由中间件返回，build 时写进产物 */
function manifest() {
  const body = () =>
    JSON.stringify(
      {
        name: learn.title,
        short_name: learn.title.slice(0, 12),
        description: learn.description,
        lang: learn.lang,
        id: BASE,
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [{ name: '闪卡复习', short_name: '闪卡', url: `${BASE}flashcards`, icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] }],
      },
      null,
      2,
    )
  return {
    name: 'learn-manifest',
    configureServer(server: any) {
      server.middlewares.use(`${BASE}manifest.webmanifest`, (_req: any, res: any) => {
        res.setHeader('Content-Type', 'application/manifest+json')
        res.end(body())
      })
    },
    generateBundle(this: any) {
      // 只给客户端包产出一次
      if (this.environment?.name === 'ssr' || (this as any).meta?.ssr) return
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: body() })
    },
  }
}
