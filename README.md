# Learn with Agent

学一个新领域就 fork 一份：**分层图**（把领域从地基到应用拆成几层、每层几个小主题）→ **每格一篇笔记** → **FSRS 闪卡**，部署到 GitHub Pages，手机上可装成 PWA 刷卡，复习记录在设备间同步。

从 [ai-infra-inferview](https://github.com/scatyf3/ai-infra-inferview) 抽出来的骨架。

## 开一个新领域

1. GitHub 上点 **Use this template** → 新仓库（比如 `learn-cuda`）。仓库名就是站点路径，不用改任何配置。
2. Settings → Pages → Source 选 **GitHub Actions**。
3. clone 下来，改 `learn.config.ts`：标题、笔记目录、分层图、闪卡牌组。
4. `npm install && npm run scaffold`：给每层、每个格子生成 `docs/stack/<id>.md` 占位页。
5. 写笔记、加闪卡，推到 `main` 就部署：`https://<you>.github.io/<仓库名>/`。

用 Claude Code 填内容的话，`CLAUDE.md` 里写了完整流程，直接说「按 CLAUDE.md 把 X 领域搭起来」即可。

## 三件套

| | 文件 | 说明 |
|---|---|---|
| 分层图 | `learn.config.ts` 的 `stacks` | 层从下往上编号；每个小主题一个格子。第一张图在首页，可以有多张 |
| 格子介绍 | `docs/stack/<小主题 id>.md`、`docs/stack/layer-N.md` | 点格子 / 层名时展开的基础介绍，也是独立页面 |
| 笔记 | `docs/<目录>/*.md` | frontmatter `stack: [<格子 id>]` 挂到图上，格子右上角计数，面板里列出 |
| 闪卡 | `src/data/flashcards.ts` | 一问一答，`ref` 链回笔记；FSRS 排复习 |

```bash
npm run new -- notes/paged-attention "PagedAttention" kv-paged layer-4   # 建一篇挂好格子的笔记
npm run scaffold      # 配置改了以后补占位页（已有的不动），并报告对不上配置的旧文件
npm run docs:dev      # 本地预览
npm test              # 配置校验 + 每个格子都有介绍页 + 闪卡 id 唯一、出处页面存在、公式能渲染
npm run docs:build    # 坏链、frontmatter 写错（status、stack 里不存在的 id）都会让构建失败
```

## 笔记 frontmatter

```yaml
---
title: 标题
status: todo        # todo | draft | reviewed：面板里的状态点
tags: []
difficulty: 3       # 1–5
order: 1            # 侧边栏里的排序
related: []         # 站内绝对路径
stack: [m-a, layer-1]  # 小主题 id 或层 key；第一张图的层 key 是 layer-N，其余图是 <图 id>-layer-N
---
```

侧边栏按 `stack` 第一项所在的层分组；没挂到图上的笔记按目录分组。

正文里 `==重点==` 高亮，`==重点=={批注}` 加悬停批注。读者在任意页面选中文字可以加自己的高亮 / 批注，右下角 ✎ 面板导出导入。

## 同步

闪卡复习记录、闪卡批注、暂停、页面批注存在 `src/data/` 下四个 json，以 GitHub 上的 `data` 分支为准：

- 任何设备点导航栏 ☁ 连一个 fine-grained token（只授权这个仓库，Contents: Read and write）后直接读写 `data` 分支。
- 本地 `docs:dev` 用电脑上的 GitHub 登录（`GH_TOKEN` / `gh auth token` / git 凭据）代为读写。
- 线上没连 token：只读拉取 `data` 分支，改动只存在这台设备。
- 部署时 workflow 把 `data` 分支最新的四个文件拷进来当初始数据。

所有 fork 都在 `<you>.github.io` 同一个域名下，localStorage、离线缓存、token 都按仓库名隔开，几份知识库互不干扰；token 每个站点各粘贴一次（同一个 token 可以勾多个仓库）。

## 加交互组件

学科专属的可视化（计算器、动画演示）放进 `docs/.vitepress/theme/components/`，在 `theme/index.ts` 里 `app.component(...)` 注册，Markdown 里顶格写标签。计算逻辑放 `src/lib/` 并补测试，组件只负责渲染。

## 仓库名推断

构建时按顺序找：环境变量 `LEARN_REPO=owner/name` → `GITHUB_REPOSITORY`（Actions 自带）→ `git remote get-url origin`。仓库名是 `<you>.github.io` 时站点挂在根路径。
