/**
 * 这份知识库对应的 GitHub 仓库（闪卡记录、批注同步到它的 data 分支）。
 *
 * 不用手填：构建时 docs/.vitepress/repo.node.ts 从 GITHUB_REPOSITORY / git remote 推出来，
 * 通过 vite 的 define 注入成 __LEARN_REPO__。测试里由 vitest.config.ts 注入。
 */
export interface RepoConfig {
  owner: string
  name: string
  /** 存数据的分支 */
  branch: string
}

declare const __LEARN_REPO__: { owner: string; name: string } | undefined

// 在 node 侧（dev server 的 dataStore）没有 define，那边自己调 detectRepo() 并显式传 repo
const injected = typeof __LEARN_REPO__ !== 'undefined' ? __LEARN_REPO__ : { owner: 'your-name', name: 'learn-stack' }

export const DATA_REPO: RepoConfig = { ...injected, branch: 'data' }

/**
 * localStorage / 缓存 key 的前缀。所有 fork 都部署在 <user>.github.io 同一个域名下，
 * 共用一份 localStorage，所以按仓库名隔开，不然几份知识库的闪卡记录会互相覆盖。
 */
export const KEY_PREFIX = `learn:${injected.name}`
