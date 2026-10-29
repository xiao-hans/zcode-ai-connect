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

## 五、各家速览

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

## 六、长回合为什么不会「突然不动」

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

## 七、「只说不做」的自动续跑

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
├── scripts/                  # sync-stall-guard.mjs:把检测器铺到各包
└── tests/                    # 检测器回归 + JS↔Python 一致性(test-detector-parity.mjs)
```

## 免责与致谢

- 三款桌面 App 的接口均为非公开协议,来自社区逆向,随时可能变动;本项目仅限个人学习使用,请遵守各 App 的服务条款。
- 协议实现源自社区项目(MIT):Trae 通道源自 [dsh-trae-connect](https://github.com/marsma-101/dsh-trae-connect) 与 Trae2api-cn 的协议文档;WorkBuddy 源自 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy);Qoder 源自 [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect);千问办公推理链 vendored 自 [pi-provider-qwenwork](https://github.com/xiao-hans/pi-provider-qwenwork)(lineage: gaoqiaoliangjie666/dsh-qwen-connect,WASM 提取自官方 `@qoder-ai/qoder-agent-sdk`)。

MIT License — 见 [LICENSE](LICENSE)。
