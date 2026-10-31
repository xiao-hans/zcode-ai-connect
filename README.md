# zcode-ai-connect

把四款国产 AI IDE 桌面 App 的模型——**Trae CN**、**WorkBuddy**、**Qoder CN**、**千问办公(QwenWork)**——以本地 OpenAI 兼容端点的形式接入 **ZCode**、**pi**、**hermes**(以及任何 OpenAI 客户端)。复用各桌面 App 已有的登录,零 API key、零按量计费。

```
                 ┌─ ZCode(插件 + SessionStart 自动拉起)
                 │
127.0.0.1:39272 ◀┤  zcode-trae-connect      ──▶ Trae CN      (llm_utils_chat 通道)
127.0.0.1:39271 ◀┼─ zcode-workbuddy-connect ──▶ WorkBuddy     (透传网关)
127.0.0.1:39270 ◀┤  zcode-qoder-connect     ──▶ Qoder CN     (COSY+WAF 协议)
127.0.0.1:39269 ◀┤  zcode-qwenwork-connect  ──▶ 千问办公       (COSY WASM 签名)
                 │
                 ├─ Codex(--profile connect-*:经 codex-responses-bridge :39268)
                 ├─ Claude Code(claude-connect.cmd:同桥 /v1/messages)
                 ├─ pi(pi-connect-services 启动扩展 + models.json 供应商)
                 └─ hermes(hermes-connect-services:on_session_start hook + config.yaml)
```

## 前置条件

- Windows + [Node.js](https://nodejs.org) 18+(四个工具均为纯 Node,零依赖);
- 对应桌面 App 已安装并**登录过一次**:Trae CN / WorkBuddy / Qoder CN / 千问办公(凭据只读复用,见各插件 README);
- ZCode(可选)、[pi coding agent](https://github.com/badlogic/pi-mono)(可选)、hermes(可选)。

已发布到 npm 的部分(四个端点可独立安装,不必 clone):

```sh
npm i zcode-trae-connect zcode-workbuddy-connect zcode-qoder-connect zcode-qwenwork-connect
```

## 一、启动方式(核心设计)

服务**不注册开机自启**。打开 ZCode / pi / hermes **任一应用**时自动拉起:

- ZCode 侧:每个插件的 `SessionStart` hook 探测端口,不在则静默拉起;
- pi 侧:`pi-connect-services` 扩展在 pi 启动时做同样的事;
- hermes 侧:`hermes-connect-services` 的 `on_session_start` shell hook 做同样的事。

手动兜底:`node <插件>/bin/cli.mjs serve --port <端口>`。

## 二、接入 ZCode

`%USERPROFILE%\.zcode\cli\config.json` 的 `plugins.dirs` 加入三个插件目录(按你的 clone 路径调整):

```jsonc
{
  "plugins": {
    "dirs": [
      "D:/path/to/zcode-ai-connect/zcode-workbuddy-connect",
      "D:/path/to/zcode-ai-connect/zcode-trae-connect",
      "D:/path/to/zcode-ai-connect/zcode-qoder-connect",
      "D:/path/to/zcode-ai-connect/zcode-qwenwork-connect"
    ]
  }
}
```

托盘退出并重开 ZCode。首次每个插件执行一次(写入模型注册表):

```sh
node <插件>/bin/cli.mjs setup      # 仅 trae / workbuddy 需要;qoder / qwenwork 开箱即用
```

模型选择器中出现 WorkBuddy / Trae / Qoder / QwenWork 分组。

### 不想 clone?用 npm 安装

四个工具与 pi 启动扩展都发布在 npm,全局安装后把 `plugins.dirs` 指向 npm 全局
`node_modules` 里的对应包目录即可(端点 CLI 也可直接 `npx zcode-qwenwork-connect serve`):

```sh
npm i -g zcode-trae-connect zcode-workbuddy-connect zcode-qoder-connect zcode-qwenwork-connect
```

## 三、接入 pi

```sh
# 1. 安装启动扩展(打开 pi 自动拉起端点;git clone 安装或 npm 包二选一)
pi install D:/path/to/zcode-ai-connect/pi-connect-services
# 或: pi install npm:pi-connect-services

# 2. 生成/刷新 pi 的供应商与模型名册(从三个端点实时拉取,含思考档位映射)
node D:/path/to/zcode-ai-connect/sync-pi-models.mjs
```

之后在 pi 里 `/model` 选 `WB ·` / `Trae ·` / `Qoder ·` 前缀的模型,或 `pi --model workbuddy/deepseek-v4.1-flash` 直接指定。上游名册变化或端点 token 轮换(报 401)时,重跑一次 `sync-pi-models.mjs` 即可。

千问办公在 pi 侧走姊妹扩展 [pi-provider-qwenwork](https://github.com/xiao-hans/pi-provider-qwenwork)(随机端口、进程内密钥),与本套件的 39269 端点互不冲突——二者读同一份桌面登录态,服务进程独立。

## 四、接入 hermes

[hermes-connect-services](hermes-connect-services/) 用一次命令完成全部件事:写 provider、写模型能力、写懒启动 hook。

```sh
node hermes-connect-services/bin/sync-hermes-config.mjs --install-hooks
```

- 写入位置:`%LOCALAPPDATA%\hermes\config.yaml`(Windows)/ `~/.hermes/config.yaml`,只动三块 `# >>> zcode-ai-connect >>>` 标记之间的区域,其余配置原样保留;写盘前自动备份 `.bak`。
- provider id:`zc-trae` / `zc-workbuddy` / `zc-qoder` / `zc-qwenwork`,`/model` 或 `--provider zc-workbuddy --model deepseek-v4.1-flash` 选用。
- 打开 hermes 即自动拉起四个端点(同 ZCode / pi 的探针+拉起逻辑)。
- Token 轮换或上游名册变化:重跑同一条命令。`--remove` 卸载,`--only <id>` 单独同步。

完整文档与排障(hooks 确认、回环被代理劫持、思考档位)见 [hermes-connect-services/README.md](hermes-connect-services/README.md)。

## 五、接入 Codex

Codex 0.142+ 只讲 Responses API(官方已硬移除 `wire_api = "chat"`),四个端点只讲 chat completions,中间由 [codex-responses-bridge](scripts/codex-responses-bridge.mjs)(127.0.0.1:39268,零依赖单文件)双向翻译。桥直读各端点 `endpoint.json` 的 port+token(30 秒缓存),token 轮换自愈,无需配置密钥。

```sh
node scripts/setup-codex.mjs            # 写入 provider + 四个 profile + 自启 hook(幂等,写前自动备份)
node scripts/setup-codex.mjs --remove   # 卸载,只动本套件写过的东西
```

之后按提供方选 profile(模型 id 带前缀消歧,同名模型各走各家):

| profile | 端点 | 默认模型 |
|---|---|---|
| `codex --profile connect-wb` | WorkBuddy | glm-5.3 |
| `codex --profile connect-trae` | Trae CN | glm-5.3 |
| `codex --profile connect-qoder` | Qoder CN | glm-5.3 |
| `codex --profile connect-qw` | 千问办公 | qwen3.8-max-preview |

profile 是独立文件 `~/.codex/connect-*.config.toml`(0.142+ 起从 config.toml 拆出),模型 id 可自行换成 `/v1/models` 里的任意一个;默认 `codex`(ChatGPT 登录)完全不受影响。新写入的 SessionStart hook 首次在 codex TUI 里会请求一次信任确认,`codex exec` 非交互模式会静默跳过未信任 hook。

实现注记(踩过的坑):

- Responses SSE 的 `data:` JSON 必须自带 `"type"` 字段,codex 按 `data.type` 分发事件;缺了它表现为「stream disconnected before completion」重试 5 次全败,与桥端是否发出 `response.completed` 无关。
- WorkBuddy 上游 WAF(11128 "unapproved channel")对 Codex 官方身份声明(开头三句,空白归一化)做指纹匹配;桥对 instructions 做语义无损改写(去牛津逗号,命中 11128 再换一处措辞重试)绕过。
- codex 在非信任目录用 read-only 沙箱跑 shell 会报 `CreateProcessWithLogonW: 267`,属 codex 自身 Windows 沙箱限制,与桥无关。

回归测试:`node scripts/test-codex-bridge.mjs`(桥协议冒烟,需桥在跑)· `node scripts/test-codex-wiring.mjs`(四端点直连冒烟,需端点在跑)。

## 六、接入 Claude Code

Claude Code 讲 Anthropic Messages 协议,同一个桥同样翻译:`POST /v1/messages` 与 `/v1/messages/count_tokens`(127.0.0.1:39268)。接入零写入——包装器 [claude-connect.cmd](scripts/claude-connect.cmd) 用 `--settings` 会话级配置覆盖,**不读不改** `~/.claude` 的登录态与 settings.json(settings.json `env` 里的 `ANTHROPIC_BASE_URL` 优先级高于 shell 环境变量,shell 传参压不过它,必须走 `--settings` 这一层):

```sh
scripts/claude-connect.cmd -p "…"   # 参数与 claude 完全一致(-p / 交互 / MCP 均可)
```

模型映射与选择器都在 [claude-connect-settings.json](scripts/claude-connect-settings.json):主模型 `wb/glm-5.3`,后台快速档(haiku 位)`qw/qwen3.8-flash`,`CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`(WorkBuddy glm-5.3 实窗口 1M)。`modelPicker` 由 [sync-claude-models.mjs](scripts/sync-claude-models.mjs) 生成——四家**全量**模型(61+)进入 `/model` 阵容,默认模型带 ★;上游名册变化后重跑 `node scripts/sync-claude-models.mjs` 刷新(需端点在跑,已开会话要重开)。

实现注记(踩过的坑):

- Claude Code 会在 system 首块塞 `x-anthropic-billing-header` 计费元数据,WorkBuddy 上游对它做通道指纹匹配(11128,改词也绕不过);桥翻译时直接剥掉该块——它是纯传输元数据。
- system 里的官方反馈链接 `github.com/anthropics/claude-code/issues` 也是指纹(大小写、斜杠归一,只认原文);桥把周边措辞「report the issue at」微调为「report issues at」绕过,链接本体保持可点;重试梯子兜底会直接破形 URL。
- Claude Code 2.1.316 会把 hook 上下文作为 `role:"system"` 的 message 发来,Codex 0.166 把系统提示词挪进 `developer` 消息——桥对两者都已正确映射。
- 网关模型发现(`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`)会过滤掉 id 不含 claude/anthropic 的条目,对本套件的前缀 id 无效;选择器走 `modelPicker` 显式阵容。

回归测试:`node scripts/test-claude-bridge.mjs`(Anthropic 协议冒烟:文本/工具/多轮 tool_result/非流式/count_tokens)。

## 七、各家速览

| | WorkBuddy | Trae CN | Qoder CN | 千问办公 |
|---|---|---|---|---|
| 端口 | 39271 | 39272 | 39270 | 39269 |
| 凭据 | 桌面登录(只读) | 桌面登录(只读,自动刷新) | 桌面登录(只读)或 PAT | 桌面登录(只读,自动刷新) |
| 协议 | OpenAI 透传网关 | llm_utils_chat(messages 直发) | COSY 签名 + WAF 编码 | COSY WASM 同源签名 |
| system 保真 | ✅ 零注入 | ✅ 实测零注入 | ⚠️ 前后包夹身份锁(详见其 README) | ✅ 消息原样透传(shim 不注入) |
| 工具调用 | ✅ 回传调用方 | ✅ 回传调用方 | ✅ 回传调用方 | ✅ 回传调用方 |
| 特色 | 每日自动签到 | 1M max 窗口 · 双版本 | 免费档模型 · 可读模型 id | 1M 窗口 · 视觉输入 · 思维链 |
| 常见坑 | 额度为 0 时限免模型仍可用 | 账号并发上限 2 会话(429 自愈) | 桌面 dt- ~16 天过期,开一次 App 刷新 | 高峰期长思考排队(首帧 90s 预算) |

各插件的完整文档(排障、命令、协议细节):[zcode-trae-connect](zcode-trae-connect/) · [zcode-workbuddy-connect](zcode-workbuddy-connect/) · [zcode-qoder-connect](zcode-qoder-connect/) · [zcode-qwenwork-connect](zcode-qwenwork-connect/)

## 八、长回合为什么不会「突然不动」

四个端点的流收尾是同一套规则,任何一个都不允许把「异常」说成「正常结束」:

| 情况 | 收尾 |
|---|---|
| 已开流后上游 180 秒零字节 | `error` 帧 + `finish_reason: "network_error"` + `[DONE]`,并中止上游 |
| 上游没给 finish 帧就断流 | `finish_reason: "length"`(截断如实上报,绝不改写成 `stop`) |
| 有 tool_calls 却标成 `stop` | 纠正为 `finish_reason: "tool_calls"` |
| 整回合只有思考、没有任何产出 | `error` 帧(`empty_answer`),让下游重试 |
| 客户端断开 | 中止上游请求 / 删除远端会话,不浪费额度也不占并发 |

看门狗间隔:`ZC_STREAM_IDLE_TIMEOUT_MS`(默认 180000ms)。心跳只保活下游,不重置看门狗。
改动前的症状正是「长时间任务后模型忽然暂停、没有报错」:上游断流被补成 `stop`,下游便把截断当成模型自己收尾。

回归测试:`node tests/test-stream-guard.mjs` · `node tests/test-stream-guard-qoder.mjs`

## 九、「只说不做」的自动续跑

模型常见的一种收尾是**宣布了下一步却直接停住**:

> 我先检查配置,再修改这里:

这一轮**没有任何工具调用**,于是宿主认为回复结束、等你说话。四个宿主各有一个挂载点兜住它:

| 宿主 | 挂载点 | 续跑方式 |
|---|---|---|
| ZCode(四个插件) | `Stop` hook | 输出 `{"decision":"block","reason":"…"}`,提示回灌上下文再请求一次 |
| pi | `turn_end` | 返回 `{continue:true, entries:[custom_message]}` |
| dsh | `agent/turn-stopping` | `agent.steer(user 消息)` 塞进 `inbox.nextStep` |
| hermes | **没有** —— 见下 | 补第 5 道收尾闸(`turn_stop_gates.py`) |

ZCode 侧的执行流程:

| 步骤 | 发生什么 |
|---|---|
| 1 | 一轮在零工具调用下准备结束时,ZCode 执行 `Stop` hook,把整段回复放进 stdin |
| 2 | `hooks/stall-detector.mjs` 给收尾打分:强/弱未来标记(`我先…`/`接下来…`/`Let me…`)+ 动作动词 + 冒号/省略号收尾 |
| 3 | 命中则输出 `{"decision":"block","reason":"<续跑提示>"}`,ZCode 把提示回灌上下文并再请求一次模型 |
| 4 | ZCode 自身限制每轮续跑次数;再给一次机会,不保证任务一定做完 |

**误判是这里唯一真正昂贵的事**,所以否决规则先于肯定规则求值:

- 以问句收尾、把决定权交回你(`请你确认`/`是否要`/`shall I`)、明确的完成宣告(`已完成`/`all done`)——一律不续跑;
- 同一段回复文本**只续跑一次**:四个插件并存时用原子指纹锁(默认 `~/.zcode-stall-guard/`,`ZCODE_STALL_GUARD_HOME` 可改)跨进程互斥,只会注入一条提示,不会四条;
- 以冒号结尾只是加权项,不足以独立触发(说明性文字大量以冒号收尾)。

**限制:Stop 载荷里没有 provider 信息**,所以这份 hook 影响 ZCode 里的所有模型,不只千问办公那一个。判定逻辑与 pi / dsh / hermes 侧共用同一套规则(`shared/stall-detector.mjs` 与 `shared/stall_detector.py`,由 `scripts/sync-stall-guard.mjs` 分发),四端阈值一致，`tests/test-detector-parity.mjs` 会逐字段比对两份实现。

### hermes 为什么是个例外

hermes 没有「回合正常结束」类的钩子点:`VALID_HOOKS` 里唯一能续跑的 `pre_verify` 要求本轮**写过文件**才触发,而「我先检查配置」这种收尾往往只读不写。所以只能往宿主的收尾闸门链里补第 5 道:

```sh
node hermes-connect-services/bin/patch-hermes-stall-gate.mjs   # --check / --revert
```

改的是 `agent/turn_stop_gates.py`(两个 marker 块)+ 新增 `agent/stall_detector.py`,宿主原有行不动,`--revert` 逐字节还原。**hermes 升级会覆盖,升级后重跑一次即可**;生效需要重启 gateway。详见 [hermes-connect-services/README.md](hermes-connect-services/README.md)。

回归测试:`node tests/test-stall-detector.mjs`、`node tests/test-detector-parity.mjs`、`node hermes-connect-services/tests/test-stall-gate.mjs`

## 目录

```
zcode-ai-connect/
├── zcode-trae-connect/       # Trae CN 接入(llm_utils_chat 通道)
├── zcode-workbuddy-connect/  # WorkBuddy 接入(含每日签到)
├── zcode-qoder-connect/      # Qoder CN 接入(双轨凭据)
├── zcode-qwenwork-connect/   # 千问办公接入(vendored WASM 签名链)
├── pi-connect-services/      # pi 启动扩展:自动拉起三个端点
├── sync-pi-models.mjs        # pi 供应商/名册同步脚本
├── hermes-connect-services/  # hermes 接入:config.yaml 同步 + 启动 hook + 收尾闸补丁
├── shared/                   # stall-detector 权威源:.mjs(ZCode/pi/dsh)+ .py(hermes)
├── scripts/                  # sync-stall-guard.mjs + codex/claude 协议桥、setup、冒烟脚本
└── tests/                    # 检测器回归 + JS↔Python 一致性(test-detector-parity.mjs)
```

## 免责与致谢

- 三款桌面 App 的接口均为非公开协议,来自社区逆向,随时可能变动;本项目仅限个人学习使用,请遵守各 App 的服务条款。
- 协议实现源自社区项目(MIT):Trae 通道源自 [dsh-trae-connect](https://github.com/marsma-101/dsh-trae-connect) 与 Trae2api-cn 的协议文档;WorkBuddy 源自 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy);Qoder 源自 [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect);千问办公推理链 vendored 自 [pi-provider-qwenwork](https://github.com/xiao-hans/pi-provider-qwenwork)(lineage: gaoqiaoliangjie666/dsh-qwen-connect,WASM 提取自官方 `@qoder-ai/qoder-agent-sdk`)。

MIT License — 见 [LICENSE](LICENSE)。
