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

也可以走 npm(四个端点包 + 本包装在同一项目里,脚本会自动在 `node_modules/` 找兄弟包):

```sh
npm i zcode-trae-connect zcode-workbuddy-connect zcode-qoder-connect zcode-qwenwork-connect hermes-connect-services
npx hermes-connect-sync --install-hooks
```

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

## 五、排障

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

## 六、测试

```sh
node hermes-connect-services/tests/test-yaml-patch.mjs
```

覆盖的是最危险的那部分:托管块插入/替换/卸载、幂等性、`--only` 不删邻居、孤儿标记自愈。

---

MIT License — 见仓库 [LICENSE](../LICENSE)。
