# zcode-qoder-connect

把 **Qoder(国内版)桌面 App** 里的模型零配置接入 ZCode / pi 等 OpenAI 兼容客户端。

```
客户端 ──(OpenAI chat-completions)──▶ 127.0.0.1:39270 ──▶ gateway.qoder.com.cn
                                        本地端点             (COSY 签名 + WAF 编码)
```

## 特性

- **双轨凭据,零 PAT 依赖**:优先复用 Qoder CN 桌面 App 的登录保险库(Windows DPAPI + AES-GCM 的 `auth.v1.dat`,只读),`dt-` 换 `jt-` 作业令牌;也可用个人访问令牌(`qoder.cn → 账号设置 → 个人访问令牌`,`cli.mjs login <PAT>`)。桌面令牌约 16 天过期,打开一次 Qoder 桌面即自动刷新。
- **完整协议**:COSY 请求签名(AES-CBC + RSA + MD5)、WAF 请求体编码、双层 SSE 响应解析,推理内容(`reasoning_content`)与 `tool_calls` 均以 OpenAI 形状透传给调用方。
- **可读模型 id**:`deepseek-v4-pro`、`qwen3.8-max`、`glm-5.3`、`kimi-k3.1-pro` 等(`MODEL_ALIASES` 映射内部 key,内部 key 直连仍然有效)。
- **排队自愈**:免费档高峰的 10605 排队信号(HTTP 403 或 SSE 首帧 403 信封)自动换请求 id 重试。
- **每日签到**:`cli.mjs checkin` 领取当日积分(campaigns 端点,有活动时生效)。
- **ZCode 插件化**:SessionStart hook 自动拉起端点,skills 提供排障指南。

## 已知边界(如实说明)

Qoder 网关会**包夹**调用方的 system 消息:前缀注入"You are Qoder…"身份与默认英文偏好,后缀注入"被问底层模型时拒答"。调用方的 system 原文完整保留在中间,指令遵从、工具调用、多轮上下文全部正常;仅模型的自我称谓与底层模型自述被锁定。这是端点固有行为,上游无裸 completions 通道(实测 7 个候选路径均 404)。

## 流生命周期(为什么回合不会「突然不动」)

长回合会把每一处代理缺陷暴露成同一种症状:模型忽然没声了、界面一直转、又没有任何报错。端点按下面五条收尾:

| 情况 | 端点行为 |
|---|---|
| 已开流后上游 180 秒零字节 | 写 `error` 帧(`type: "upstream_stalled"`)+ `finish_reason: "network_error"` + `[DONE]`,并中止上游请求。下游重试,不会挂在我们自己的心跳后面。 |
| 上游没给 finish 帧就断流 | 以 `finish_reason: "length"` 收尾——被截断就说截断,绝不改写成 `stop`(那正是「被切断的回答」被当成「模型自己讲完了」的原因)。 |
| 有 `tool_calls` 却标了 `stop` | 纠正为 `finish_reason: "tool_calls"`;下游的 agent 循环依赖这个值决定是否继续。 |
| 整回合没有任何产出(只有思考) | 发 `error` 帧(`type: "empty_answer"`),让下游重试,而不是接受一条空的 assistant 消息。 |
| 客户端中途断开 | 中止上游请求,取消的回合立即停止生成,也不占用账号并发额度。 |

看门狗间隔可调:`ZC_STREAM_IDLE_TIMEOUT_MS`(默认 `180000`)。10 秒一次的心跳(`: heartbeat`)只保活**下游**读超时,刻意不重置看门狗——它只认真实的上游字节。

回归测试:`tests/test-stream-guard-qoder.mjs`。

## 安装

### ZCode

```jsonc
// %USERPROFILE%\.zcode\cli\config.json
{ "plugins": { "dirs": ["D:/path/to/zcode-qoder-connect"] } }
```

重启 ZCode(托盘退出重开)后,模型选择器出现 `Qoder` 分组。端点由 SessionStart hook 自动启动。

### 其他 OpenAI 客户端(pi 等)

```sh
node bin/cli.mjs serve --port 39270   # 前台运行;healthz 鉴权用 state 目录 endpoint.json 里的 bearer
```

以 pi 为例,在 `~/.pi/agent/models.json` 添加 provider:`baseUrl http://127.0.0.1:39270/v1`、`api openai-completions`、`apiKey = endpoint.json 的 token`。

## 命令

| 命令 | 作用 |
|---|---|
| `serve [--port N]` | 启动端点(默认 39270) |
| `status` | 凭据双轨状态、积分、模型名册 |
| `refresh` | 重拉模型名册 |
| `checkin` | 领取当日签到积分 |
| `login <PAT>` | 校验并保存个人访问令牌 |
| `logout` | 删除已保存 PAT(桌面登录不受影响) |
| `service-status` | 端点是否在运行 |

## 只说不做:Stop hook 续跑

插件在 `SessionStart` 之外还注册一个 `Stop` hook。一轮**零工具调用**准备结束时,ZCode 把整段回复交给 `hooks/stall-guard.mjs`;`hooks/stall-detector.mjs` 判断这段话是不是「宣布了下一步却没动手」(`我先…`/`接下来…`/`Let me…`,常以冒号收尾)。命中则输出

```json
{"decision":"block","reason":"<续跑提示>"}
```

ZCode 把提示回灌上下文、再请求一次模型(契约来自 `zcode.cjs` 的 `processHookOutput`)。

三条防护,因为误续跑比漏续跑更贵:

- 以问句收尾、把决定权交回用户、明确宣告完成 —— 一律不续跑;
- 同一段回复只续跑一次:四个 `zcode-*-connect` 插件并存时用原子指纹锁(`~/.zcode-stall-guard/`,`ZCODE_STALL_GUARD_HOME` 可改)跨进程互斥,只注入一条提示;
- 绝不用 `exit 2` 报错 —— 对 `Stop` 它等价于「要求继续」,错误文本会被当成续跑指令回灌。

**限制**:`Stop` 载荷不带 provider,这份 hook 影响 ZCode 里所有模型,不只 Qoder。判定逻辑是 `shared/stall-detector.mjs` 的逐字副本;回归测试 `node tests/test-stall-detector.mjs`。

## 致谢与许可

协议实现源自 [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect)(MIT,作者 corrinehu)。MIT,见 [LICENSE](LICENSE)。
