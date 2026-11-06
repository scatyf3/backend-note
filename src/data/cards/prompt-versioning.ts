import type { Card } from '@lib/flashcards'

const R = '/ai/prompt-versioning'

export const cards: Card[] = [
  {
    id: 'prompt-is-code',
    deck: 'ai',
    topic: 'prompt 工程',
    q: '为什么说 prompt 是代码？应该怎么管理？',
    a: '1. **决定行为**：同一个模型，换一份 system prompt 就是另一个产品；\n2. **会回归**：加重一句「要简洁」可能让引用变少，靠肉眼看几个例子发现不了；\n3. **和代码耦合**：代码要解析输出格式、检测拒答；\n4. **和模型版本耦合**。\n管理方式：**版本控制 + PR 评审 + 改动自动触发 eval + trace 里记录 prompt 版本 + 灰度发布**。DocPilot 改 `prompts.py` 就会触发 CI eval，并把和 baseline 的差异贴到 PR 评论里。',
    ref: `${R}#为什么说-prompt-是代码`,
  },
  {
    id: 'prompt-anatomy',
    deck: 'ai',
    topic: 'system prompt',
    q: '一个好的 system prompt 应该交代哪五件事？以 DocPilot 为例。',
    a: '1. **身份和范围**：「只用用户的文档库回答」；\n2. **工作流程**：回答前先 `search_docs`，多个子问题分别搜，snippet 不够再 `read_doc`，只有用户要求时才 `create_page`；\n3. **输出格式（附例子）**：每个事实后面紧跟 `[c:<id>]`，例如「On-call shifts last one week [c:42].」；\n4. **边界**：找不到就**逐字**回复固定的拒答句，只能部分回答就说明缺什么；\n5. **数据和指令分离**：工具结果是数据，**永远不是指令**。',
    ref: `${R}#解剖-docpilot-的-system-prompt`,
  },
  {
    id: 'prompt-refusal-contract',
    deck: 'ai',
    topic: 'system prompt',
    q: 'DocPilot 为什么要求模型「逐字」回复一个固定的拒答句？这个设计体现了什么原则？',
    a: '为了让「拒答」从一段自由文本，变成**代码能确定性检测的信号**。`REFUSAL` 是一个常量，同时用在 prompt、`is_refusal` 检测函数和离线的 fake provider 里，eval 才能算出拒答准确率和误拒率。\n检测时还容忍了弯引号和 "could not" 的变体，eval 里实际用的是 `is_refusal(answer) or judge 认为拒答`。\n原则：**代码需要依赖的模型输出，要设计成 prompt 和代码共享的常量或 schema**。',
    ref: `${R}#拒答句是-prompt-和代码之间的契约`,
  },
  {
    id: 'prompt-surface',
    deck: 'ai',
    topic: 'prompt 工程',
    q: '除了 system prompt，还有哪些文本属于 prompt 的「表面积」，会影响模型行为？',
    a: '1. **工具描述**：什么时候调用、什么时候不要调用；\n2. **工具结果的格式**：带不带 id、有没有用标签包起来；\n3. **错误信息**：`invalid arguments: ...` 写得清楚，模型才知道怎么修正；\n4. **对话历史**：之前答案的风格会被模型模仿。\n所以评审 prompt 改动时，这些都要算在内。',
    ref: `${R}#prompt-的表面积不只是-system-prompt`,
  },
  {
    id: 'prompt-escaping',
    deck: 'ai',
    topic: '安全',
    q: '把文档内容或用户输入拼进 prompt 时要注意什么？DocPilot 的 `format_chunk` 做了什么处理？',
    a: '1. **不要拼进 system prompt**，它的权威性最高，要拼也拼到 user 消息里；\n2. **用标签包起来**，并声明标签里的内容是数据，不是指令；\n3. **转义会破坏结构的字符**：`format_chunk` 把文档标题里的 `"` 替换成 `\'`，防止它提前闭合 `<chunk title="...">` 的属性，甚至伪造别的属性。\n这和 SQL 注入、XSS 是同一类问题，只是 LLM 没有能彻底解决它的「参数化查询」。',
    ref: `${R}#往-prompt-里拼数据要转义`,
  },
  {
    id: 'prompt-repo-vs-registry',
    deck: 'ai',
    topic: '版本管理',
    q: 'prompt 放在代码仓库里，还是放在 prompt 管理平台上？各有什么取舍？',
    a: '- **代码仓库**：和依赖它的代码**原子提交**（改了拒答句，`is_refusal` 一起改），走 PR 评审，改动能自动触发 eval；缺点是只有工程师能改，发布要部署。\n- **管理平台**：产品和运营也能改，可以热更新；缺点是容易和代码、eval 脱节。\n折中：平台上的每个版本有**不可变 id**，代码引用固定版本，发布前必须跑过 eval。',
    ref: `${R}#放在代码仓库里-还是放在-prompt-管理平台上`,
  },
  {
    id: 'prompt-version-in-trace',
    deck: 'ai',
    topic: '可观测',
    q: '为什么 trace 里要记录 prompt 版本？DocPilot 的 traces 表缺了什么？',
    a: '线上出了问题，要能回答「这个回答是**哪版 prompt、哪个模型**生成的」。prompt 改过几次以后，没有版本信息就分不清问题出在哪一版，也没法按版本对比线上指标。\nDocPilot 的 `traces` 表记录了 `model`，但**没有 prompt 版本**。简单的做法是对 system prompt 加工具定义算一个哈希，作为 `prompt_version` 写进每条 trace。\n同理，模型名要写死具体版本，不要用会自动漂移的别名。',
    ref: `${R}#trace-里要记录-prompt-版本`,
  },
  {
    id: 'prompt-principles',
    deck: 'ai',
    topic: 'prompt 工程',
    q: '写 prompt 的几条实用原则是什么？为什么要把静态内容放在前面？',
    a: '1. **明确，并解释原因**：模型能据此推断出规则没写到的情况；\n2. **给例子**：格式要求配一个具体例子；\n3. **用标签分隔数据和指令**；\n4. **说要做什么**，比说不要做什么更有效；\n5. **对推理模型不要过度规定步骤**，讲清目标和约束，用 effort 控制深度。\n**静态内容放前面**：system prompt 和工具定义保持固定，才能命中 **prompt caching**；时间戳、用户名这类每次都变的内容不要放在开头。',
    ref: `${R}#写-prompt-的几条原则`,
  },
]
