# pi-turn-guard

Pi 扩展：模型**收尾时什么都没给**的时候，自动补一轮。

## 为什么要它

两个实测出来的坑：

1. **空回合** —— 模型只留下 thinking，正文为空、也没调工具就以 `stop` 收尾。
   `usage.output` 显示 token 确实消耗了（286 / 667），耗时却只有 7.6s、15.5s，
   不是超时被切。用户看到的就是「思考着，突然不工作了」。
   判定器对空文本返回 `empty`（不续跑），所以谁都没管这个场景。
2. **trae / workbuddy / qoder 没有守卫** —— 这三个在 pi 上只是 `models.json` 里的
   普通 openai-completions provider（指向本地端点 39270/39271/39272），
   `pi-provider-qwenwork` 自带的守卫硬编码只认 `qwenwork`，覆盖不到它们。

## 行为

挂在 `agent_before_settle`（pi 0.1.4+）上，只在这一轮**正常完成**（`outcome === 'completed'`）
且**没有任何工具调用**时才可能介入：

| 场景 | 是否续跑 | 说明 |
|---|---|---|
| 空回合（正文为空、无工具） | 是 | 所有 provider 都管，包括 qwenwork |
| stall：宣布下一步却没动手 | 是 | 仅限**没有自带守卫**的 provider |
| stall 且 provider=qwenwork | 否 | 交给 pi-provider-qwenwork，避免塞两条提示 |
| 用户中断 / 出错的回合 | 否 | `outcome !== 'completed'` |
| 已经有别的守卫要求继续 | 否 | `event.continue` 为真 |
| 本轮已经调过工具 | 否 | 不存在「只说不做」 |

同一条用户输入之后最多续跑 `MAX_AUTO_CONTINUES = 2` 次；用户一发新消息，预算重置。

全程 fail-open：解析出错、上下文拿不到、预算耗尽，都让这一轮正常结束。

## 安装

```sh
pi install npm:pi-turn-guard
```

需要 pi 提供 `agent_before_settle` 事件（0.1.4+ 的事件名；更早的 `turn_end` 不会触发）。

MIT。
