import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import config from '../../../learn.config'
import { buildIndex, defineLearn, layerKeyOf, type LearnConfig } from '@lib/config'

const base = (): LearnConfig => ({
  title: 't', description: '', lang: 'zh-CN',
  domains: [{ dir: 'notes', label: 'n', short: 'n', color: '#000', order: 1 }],
  stacks: [{ id: 'a', name: 'A', home: '/', prefix: 'L', layers: [{ id: 0, name: 'x', en: 'x', short: 'x', scope: '', color: '#000', topics: [{ id: 't1', name: 't1' }] }] }],
  decks: [{ id: 'core', label: 'c', color: '#000' }],
})

describe('learn.config', () => {
  it('当前配置能通过校验', () => {
    expect(() => defineLearn(config)).not.toThrow()
  })

  it('拦下重名的小主题、长得像层 key 的 id、被占用的目录名', () => {
    const dup = base(); dup.stacks[0].layers[0].topics.push({ id: 't1', name: 'again' })
    expect(() => defineLearn(dup)).toThrow(/重复/)
    const bad = base(); bad.stacks[0].layers[0].topics[0].id = 'layer-3'
    expect(() => defineLearn(bad)).toThrow(/层 key/)
    const dir = base(); dir.domains[0].dir = 'stack'
    expect(() => defineLearn(dir)).toThrow(/占用/)
  })

  it('层 key：第一张图 layer-N，其余 <id>-layer-N；数字按第一张图解析', () => {
    const c = base()
    c.stacks.push({ ...c.stacks[0], id: 'b', home: '/b/', layers: [{ ...c.stacks[0].layers[0], topics: [{ id: 't2', name: 't2' }] }] })
    expect(layerKeyOf(c.stacks, c.stacks[0], 0)).toBe('layer-0')
    expect(layerKeyOf(c.stacks, c.stacks[1], 0)).toBe('b-layer-0')
    const { normalize } = buildIndex(c.stacks)
    expect(normalize(0)).toBe('layer-0')
    expect(normalize('b-layer-0')).toBe('b-layer-0')
    expect(normalize('t2')).toBe('t2')
    expect(normalize('nope')).toBeUndefined()
  })

  it('每个格子都有 docs/stack/<key>.md（没有就跑 npm run scaffold）', () => {
    const docs = fileURLToPath(new URL('../../../docs/stack/', import.meta.url))
    const missing = [...buildIndex(config.stacks).byKey.keys()].filter((k) => !existsSync(`${docs}${k}.md`))
    expect(missing, '跑 npm run scaffold 补齐').toEqual([])
  })
})
