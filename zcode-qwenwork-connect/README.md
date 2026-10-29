# zcode-qwenwork-connect

把**千问办公（QwenWorkCN）桌面 App** 的模型——`pro`（高级）、`qwen3.8-flash`（标准）、`qwen3.8-max-preview`——以本地 OpenAI 兼容端点的形式接入 **ZCode**。复用桌面 App 已有的登录态，零 API key、零额外配置。

本插件是 [zcode-ai-connect](https://github.com/xiao-hans/zcode-ai-connect) 套件的第四个成员（trae / workbuddy / qoder / qwenwork），推理链 vendored 自姊妹项目 [pi-provider-qwenwork](https://github.com/xiao-hans/pi-provider-qwenwork)（与 DSH 插件 [dsh-qwen-connect](https://github.com/xiao-hans/dsh-qwen-connect) 同源）。

```
ZCode ──(OpenAI chat-completions)──▶ 127.0.0.1:39269/v1 ──签名+加密──▶ gateway.qwenwork.cn
                                      本地端点                          (COSY WASM 签名)
```

## 工作原理

1. **读登录态**：vendored `lib/credentials.js` 从 `%APPDATA%\QwenWorkCN` 用 Windows DPAPI + AES-256-GCM 解出桌面 App 的 `auth-v2.dat`；token 过期时自动走 `deviceToken/refresh` 轮换并原子回写。
2. **签名**：`lib/signer-session.js` 用官方 App 同源的 `wasm.bin`（提取自 `@qoder-ai/qoder-agent-sdk`）生成 `Authorization: Bearer COSY.*` 与全套 `Cosy-*` 头。
3. **网关**：`lib/chat-shim.js` 把 OpenAI 请求翻译成上游 `agent_chat_generation` SSE，再把响应翻译回 OpenAI 格式（含 `reasoning_content` 思维链、工具调用、图片输入），并按五条收尾语义保证回合不会"突然不动"（详见 pi-provider-qwenwork README）。
4. **端点**：本插件的 `src/server.js` 把该 handler 挂到套件固定端口 **39269**，补上 `/v1/models` 与 `/healthz` 两个发现路由，bearer 用 `endpoint.json` 里持久化的 token——与套件内其他三个工具同一契约。

## 前置条件

- **Windows**（凭据解密依赖 DPAPI）+ Node.js 18+（零 npm 依赖）。
- 已安装并**已登录**千问办公桌面客户端（QwenWorkCN）。本插件不弹窗登录，只读取 App 已有的登录态；报"未登录"时打开一次 App 即可。
- 企业 VPC 租户（凭据 JWT 的 `iss` 含 `.vpc.`）会自动派生到租户网关，无需配置。

## ZCode 安装

把本目录作为 ZCode 插件安装（或放入套件仓库后按套件 README 注册 provider）。`SessionStart` hook 会在打开 ZCode 时自动拉起端点。

模型选择器里的三档：

| 模型 id | 档位 | 倍率 | 说明 |
|---|---|---|---|
| `pro` | 高级 | ×1.00 | 默认档 |
| `qwen3.8-flash` | 标准 | ×0.10 | 日常首选，最便宜 |
| `qwen3.8-max-preview` | Max | ×1.10 | 千问最强模型 |

均为 1M 上下文、32K 输出、支持图片与思维链。所有调用按倍率计入千问办公账号额度。

## CLI

```sh
node bin/cli.mjs serve            # 启动端点（默认 39269）
node bin/cli.mjs status           # 登录态、额度、模型名册
node bin/cli.mjs doctor           # 凭据 + 网关 + WASM 签名器诊断
node bin/cli.mjs service-status   # 端点是否在运行
```

## pi 用户

pi 侧由姊妹扩展 [pi-provider-qwenwork](https://github.com/xiao-hans/pi-provider-qwenwork) 直接注册（随机端口、进程内密钥），与本端点互不冲突：二者读同一份桌面登录态，但服务进程独立。本插件面向 ZCode 及其他标准 OpenAI 客户端。

## 安全边界

- 本地端点只绑 `127.0.0.1`；环回校验（Host/Origin）+ 持久化 bearer 双重鉴别。
- 凭据只在内存中传递；日志不含 token；上游错误经脱敏后才回传。
- 本插件不向千问办公上游之外的任何地址发起请求。

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

**限制**:`Stop` 载荷不带 provider,这份 hook 影响 ZCode 里所有模型,不只千问办公。判定逻辑是 `shared/stall-detector.mjs` 的逐字副本;回归测试 `node tests/test-stall-detector.mjs`。

## 来源与许可

MIT。`vendor/lib/` 与 `vendor/research/` vendored 自
[xiao-hans/pi-provider-qwenwork](https://github.com/xiao-hans/pi-provider-qwenwork)（其推理链 lineage：
[gaoqiaoliangjie666/dsh-qwen-connect](https://github.com/gaoqiaoliangjie666/dsh-qwen-connect) 的衍生版，协议逆向 / WASM 签名成果归属上游作者）。
`vendor/research/wasm.bin` 提取自官方 `@qoder-ai/qoder-agent-sdk`，版权归其原作者；仅为互操作目的复用。
本仓库只做宿主适配（固定端口端点、发现路由、CLI、ZCode 插件层），未改动推理逻辑。
