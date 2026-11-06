---
title: 闪卡
---

# 闪卡

> 只想刷卡的话用 [单独的闪卡页](/flashcards)：没有侧边栏和说明，手机上评分按钮固定在屏幕底部。两边的复习记录是同一份。

每张卡链回站内对应的笔记。先自己答，再翻面，按这次想起来的程度点 Again / Hard / Good / Easy，[FSRS](https://github.com/open-spaced-repetition/ts-fsrs) 据此安排下次复习的时间：记得牢的隔得越来越久，忘了的很快再出现。

快捷键：<kbd>空格</kbd> 翻面（翻面后再按一次 = Good），<kbd>1</kbd>–<kbd>4</kbd> 对应 Again / Hard / Good / Easy，<kbd>→</kbd> 跳过（排到这一轮最后）。不想再看到的卡点「暂停这张」，在「全部卡片」里可以恢复。

<Flashcards />

加卡片、改题面：改 `src/data/flashcards.ts`；牌组在 `learn.config.ts` 的 `decks` 里登记。
