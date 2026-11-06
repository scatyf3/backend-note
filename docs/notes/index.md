---
title: 笔记
---

# 笔记

<script setup>
import { data as topics } from '../.vitepress/data/topics.data'
const notes = topics.filter((t) => t.domain === 'notes' && !t.isIndex)
const label = { todo: '未写', draft: '草稿', reviewed: '已复习' }
</script>

<ul>
  <li v-for="t in notes" :key="t.url"><a :href="t.url">{{ t.title }}</a> <small>· {{ label[t.status] }}</small></li>
</ul>
