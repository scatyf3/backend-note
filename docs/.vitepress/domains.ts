/** 笔记目录：数据在根目录的 learn.config.ts */
import config from '../../learn.config'
export type { Domain } from '../../src/lib/config'

export const domains = [...config.domains].sort((a, b) => a.order - b.order)
export const domainByDir = Object.fromEntries(domains.map((d) => [d.dir, d]))
