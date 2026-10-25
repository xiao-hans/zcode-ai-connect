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

## 致谢与许可

协议移植自 [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect)(MIT,作者 corrinehu),在本机凭据上对 wire 行为做了逐字段实测与修正(wire 层 tools 为 OpenAI 嵌套形、system/user content 为字符串、10605 排队重试等)。MIT,见 [LICENSE](LICENSE)。
