# hermes-connect-services

把 zcode-ai-connect 的四个本地端点接进 [hermes](https://github.com/NousResearch/hermes-agent):打开 hermes 自动拉起服务,模型选择器里出现 Trae / WorkBuddy / Qoder / 千问办公四组模型。零依赖、零 API key、零按量计费。

```
hermes ──▶ 127.0.0.1:39272   zcode-trae-connect      ──▶ Trae CN
      ──▶ 127.0.0.1:39271   zcode-workbuddy-connect ──▶ WorkBuddy
      ──▶ 127.0.0.1:39270   zcode-qoder-connect     ──▶ Qoder CN
      ──▶ 127.0.0.1:39269   zcode-qwenwork-connect  ──▶ 千问办公
```

## 一、安装

```sh
# 1. 同步 provider 到 hermes 的 config.yaml(从四个端点实时拉名册与 token)
node hermes-connect-services/bin/sync-hermes-config.mjs

# 2. 打开 hermes 自动拉起服务(写入 hooks.on_session_start)
node hermes-connect-services/bin/sync-hermes-config.mjs --install-hooks
```

两步可以合成一次带 `--install-hooks` 的运行。

`--install-hooks` 顺手把 hook 真正跑起来所需的两件东西一起办了(只写 config.yaml 是不够的):

| 目标文件 | 写入内容 | 少了它会怎样 |
|---|---|---|
| `shell-hooks-allowlist.json` | `on_session_start` 的审批条目 | hook 每次会话都被跳过,端点从不启动 |
| `.env` | 托管块 `NO_PROXY=127.0.0.1,…` | 代理软件会把回环调用吞掉 |

写完**重启 hermes**:hook 只在网关启动时注册。

也可以走 npm(四个端点包已是本包的 `dependencies`,一个命令就会一起装上):

```sh
npm i hermes-connect-services
npx hermes-connect-sync --install-hooks
```

启动器按「本包所在目录的同级」找四个端点,因此 npm 扁平安装、`npm i -g`、pnpm、yarn berry 的布局都能命中;非标准布局用 `AI_CONNECT_SUITE_ROOT=<套件根>` 覆盖。

> 整个套件只支持 **Windows**(四个端点都要读桌面 App 的登录态),所以本包声明了 `"os": ["win32"]`,在 macOS/Linux 上 `npm i` 会直接报 `EBADPLATFORM`,而不是装完静默失效。

配置文件位置自动探测:

| 平台 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\hermes\config.yaml` |
| 其他 | `~/.hermes/config.yaml` |
| 覆盖 | 环境变量 `HERMES_HOME`,或 `--config <path>` |

每次写盘前备份为 `config.yaml.bak`。

## 二、写进去的东西

脚本只碰三块**标记注释**之间的区域,其余字节一个不动(注释、缩进、你的手工配置全部保留):

```yaml
providers:
  # >>> zcode-ai-connect >>>
  zc-trae:
    name: "Trae CN"
    base_url: "http://127.0.0.1:39272/v1"
    api_mode: "chat_completions"
    api_key: "<端点 token>"
    discover_models: false
    request_timeout_seconds: 600
    models:
      "Doubao-Seed-2.1-Pro": {}
      ...
  # <<< zcode-ai-connect <<<

model_overrides:
  # >>> zcode-ai-connect >>>
  zc-trae:
    "Doubao-Seed-2.1-Pro":
      context_window: 1000000
      supports_tools: true
      supports_reasoning: true
      supports_vision: false
  # <<< zcode-ai-connect <<<

hooks:
  # >>> zcode-ai-connect >>>
  on_session_start:
    - command: '"<node.exe>" "<...>/ensure-services.mjs"'
      timeout: 30
  # <<< zcode-ai-connect <<<
```

- provider id 一律 `zc-` 前缀,与 hermes 内建(openrouter / nous / gemini …)和你自己写的 provider 互不干扰;
- `discover_models: false` —— 模型清单在同步时就写死,hermes 不必为了渲染选择器去探测一个没启动的 sidecar;
- `request_timeout_seconds: 600` —— 长思考模型排队到首帧可能要 90 秒,默认超时会掐掉合法请求;
- `--only <id>` 只重写指定 provider,其余托管内容原样保留。

## 三、选模型

```
/model                                   # 交互选择
hermes --provider zc-workbuddy --model deepseek-v4.1-flash
```

或在 `config.yaml` 里直接改默认:

```yaml
model:
  provider: zc-workbuddy
  default: deepseek-v4.1-flash
  base_url: http://127.0.0.1:39271/v1
```

## 四、命令

| 命令 | 作用 |
|---|---|
| `node bin/sync-hermes-config.mjs` | 同步四个 provider 的模型名册与 token |
| `… --install-hooks` | 额外写入 `hooks.on_session_start` 懒启动 |
| `… --remove` | 移除本工具在 config.yaml 里的全部托管块(干净卸载) |
| `… --only zc-trae` | 只同步一个端点 |
| `… --ensure` | 同步前先把没起来的端点拉起来 |
| `… --dry-run` | 只打印要改什么,不写盘 |
| `… --no-reasoning` | 全部模型标 `supports_reasoning: false` |
| `… --config <path>` | 指定配置文件 |
| `node bin/ensure-services.mjs [--verbose]` | 单独执行懒启动(也是 hook 本体) |
| `node bin/patch-hermes-stall-gate.mjs` | 给 hermes 补「宣布下一步却没动手」的续跑闸门 |
| `… --check` | 只报告补丁状态(升级后跑一次看是否失效) |
| `… --revert` | 撤销补丁,恢复到原始字节 |

## 五、续跑闸门:模型说要做什么,然后就停了

模型常见的收尾是「我先检查配置，再修改这里：」——宣布了下一步,零工具调用就结束这一轮。这不是完成,是卡住。

ZCode / pi / dsh 三端各有一个官方钩子点可以兜住(Stop hook、`turn_end`、`agent/turn-stopping`)。**hermes 没有**:

- `hermes_cli/plugins.py` 的 `VALID_HOOKS` 里没有任何「回合正常结束」事件(`agent_loop_stopped` 是 `/stop` 打断,不是收尾)。
- 唯一能续跑的闸门是 `pre_verify`,但它的前置条件是 `if _edited and has_hook("pre_verify")` —— 本轮**写过文件**才触发。而「我先检查配置」这种收尾往往只读不写,或一个工具都没调,正好落在门控之外。
- 内置的 `_dropped_toolcall_nudge` 只处理 `finish_reason == "tool_calls"` 但 `tool_calls` 为空 —— 协议层信号,精确但覆盖面窄。

所以只能往宿主的收尾闸门链里加第 5 道。

```sh
node bin/patch-hermes-stall-gate.mjs            # 打补丁
node bin/patch-hermes-stall-gate.mjs --check    # 看状态
node bin/patch-hermes-stall-gate.mjs --revert   # 干净回退
```

改动面刻意压到最小 —— 宿主原有行一个字节不动:

| 文件 | 改动 |
|---|---|
| `agent/turn_stop_gates.py` | 两个 marker 块:模块级判定函数 + 一处调用 |
| `agent/stall_detector.py` | 新增,判定逻辑本体(与 JS 版逐条对齐) |

`--revert` 会从首次打补丁时留下的快照还原 `turn_stop_gates.py`,实测与原始文件**逐字节相同**。

### 生效方式

**改完必须重启 hermes gateway** —— 已 import 的模块不会自动重载,不重启就等于没打。

### hermes 升级会覆盖

自更新会重置 `hermes-agent/` 下的源码,两块一起消失。表现是「续跑不再发生」而不是报错:模块级 import 包在 `try/except` 里,`stall_detector.py` 不在时闸门静默失效,不影响正常结束。升级后重跑一次脚本即可,`--check` 会告诉你当前状态。

### 开关与防护

```yaml
agent:
  stall_guard: false      # 或环境变量 HERMES_STALL_GUARD=0
```

- **同一段回复只续一次**:按文本 sha1 指纹去重,模型被提示后原样复读不会二次触发。
- **一个会话上限 3 次**:与 ZCode 侧一致。连续 3 次都唤不醒,再提示也只是复读计划。
- **本轮有工具调用就不判**:`_zc_tool_calls_this_turn()` 只看最后一条 user 消息之后的 `tool_calls`,`> 0` 一律跳过。
- 闸门内部全部 fail-open:任何异常只写 debug 日志,绝不让一次正常收尾因为插件出错而崩。

### 阈值不是「看到冒号就续跑」

判定是打分制,否决规则先于肯定规则求值:问句收尾、把决定权交回用户、明确完成宣告 —— 一律不续跑。冒号只是加权项(说明性文字大量以冒号收尾)。规则表与 ZCode / pi / dsh 完全同源,`tests/test-detector-parity.mjs` 会拿同一批文本喂给 JS 与 Python 两份实现,逐字段比对 `verdict` / `score` / `signals` —— 任一边改了规则而另一边没跟上,这个测试就红。

### 一个已知差异

ZCode 的 Stop hook 由宿主保证「只在一轮零工具调用时执行」,所以那边按**每轮**计数。hermes 这边没有可靠的轮次标识(续跑本身会追加一条 user 消息),所以上限按**会话**计:同一会话累计续跑 3 次后不再触发。保守方向是一致的 —— 只能少续,不会多续。

## 六、排障

**401 / 模型不在了** — 端点 token 轮换或上游名册变了,重跑 `sync-hermes-config.mjs`。

**hook 被静默跳过 —— 这是最常见的"provider temporarily unavailable"真因。** hermes 只运行 `(event, command)` 出现在 `shell-hooks-allowlist.json` 里的 hook;没列入的会被日志记一句 `not allowlisted … — skipped` 然后**永不执行**,于是四个端点从未启动,hermes 侧只看到 connection refused,一路重试到 5 个 cycle。

`--install-hooks` 现在会自己把这一对写进 allowlist(位于 hermes home,与 config.yaml 同级),并保留你其他的 hook 审批。检查:

```sh
node bin/sync-hermes-config.mjs --install-hooks --verbose   # 应输出 hook allowlist: added|present
grep -c allowlisted ~/AppData/Local/hermes/logs/agent.log   # 不该再增长
```

手工兜底(可选,范围更大):

```yaml
hooks_auto_accept: true
```

**改完必须重启 hermes** — hook 在网关启动时注册,已运行的会话不会补挂。

**连不上回环地址(`404 no such route` 带绝对 URL,或 connection refused)** — hermes 是 Python + httpx,会读 `HTTP_PROXY` / `HTTPS_PROXY`。历史上这条会把手打回环的请求送去代理,`--install-hooks` 因此会在 hermes home 的 `.env` 里托管一段:

```
# >>> zcode-ai-connect >>>
NO_PROXY=127.0.0.1,localhost,::1,0.0.0.0
no_proxy=127.0.0.1,localhost,::1,0.0.0.0
# <<< zcode-ai-connect <<<
```

实测 httpx + openai SDK 通常已自行放行 `127.0.0.1`,这段属于兜底:机器换代理软件、或代理换成强制拦截型时能少一次排查。(`.env` 是 `override=True` 载入的,所以它会顶掉系统里同名的 `NO_PROXY`;要在代理侧仍走别的例外host,把它们的域名补进这四行。)

**Thoughts 太长被压缩** — `model_overrides` 里的 `context_window` 来自端点实时 roster;换模型名后重跑同步脚本同步上下文窗口。

**思考档位** — hermes 全局 `agent.reasoning_effort` 默认 `ultra`,这些端点会原样转发 OpenAI 的 `reasoning_effort`。上游不认 `ultra` 时把它降到 `high`。不想让任何模型思考就加 `--no-reasoning`。

## 七、测试

```sh
node tests/test-yaml-patch.mjs          # 托管块插入/替换/卸载、幂等、--only、孤儿标记自愈
node ../tests/test-detector-parity.mjs  # JS ↔ Python 判定器逐字段对齐
node tests/test-stall-gate.mjs          # 闸门行为(需要本机装有 hermes)
```

`test-stall-gate.mjs` 直接 import 宿主的 `apply_stop_gates`,让整条闸门链真实跑一遍 —— 不是 mock 一个函数名对得上就算过。

---

MIT License — 见仓库 [LICENSE](../LICENSE)。
