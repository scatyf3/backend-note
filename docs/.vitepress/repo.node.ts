import { execSync } from 'node:child_process'

/**
 * 推出这份知识库的 GitHub 仓库：
 *   1. 环境变量 LEARN_REPO=owner/name（手动覆盖）
 *   2. GITHUB_REPOSITORY（GitHub Actions 里自动有）
 *   3. 本地 `git remote get-url origin`
 * 都没有就用占位名，站点照样能本地跑，只是同步不了 GitHub。
 */
export function detectRepo(): { owner: string; name: string } {
  const fromSlug = (slug?: string) => {
    const m = slug?.trim().match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
    return m ? { owner: m[1], name: m[2] } : undefined
  }
  const env = fromSlug(process.env.LEARN_REPO) ?? fromSlug(process.env.GITHUB_REPOSITORY)
  if (env) return env
  try {
    const url = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
    if (m) return { owner: m[1], name: m[2] }
  } catch {}
  return { owner: 'your-name', name: 'learn-stack' }
}

/** GitHub Pages 的 base：<user>.github.io 这个仓库挂在根上，其余挂在 /<仓库名>/ */
export const baseOf = (repo: { owner: string; name: string }) =>
  repo.name.toLowerCase() === `${repo.owner.toLowerCase()}.github.io` ? '/' : `/${repo.name}/`
