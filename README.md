# zcode-ai-connect

把三款国产 AI IDE 桌面 App 的模型——**Trae CN**、**WorkBuddy**、**Qoder CN**——以本地 OpenAI 兼容端点的形式接入 **ZCode** 与 **pi**(以及任何 OpenAI 客户端)。复用各桌面 App 已有的登录,零 API key、零按量计费。

```
                 ┌─ ZCode(插件 + SessionStart 自动拉起)
                 │
127.0.0.1:39272 ◀┤  zcode-trae-connect      ──▶ Trae CN      (llm_utils_chat 通道)
127.0.0.1:39271 ◀┼─ zcode-workbuddy-connect ──▶ WorkBuddy     (透传网关)
127.0.0.1:39270 ◀┤  zcode-qoder-connect     ──▶ Qoder CN     (COSY+WAF 协议)
                 │
                 └─ pi(pi-connect-services 启动扩展 + models.json 供应商)
```

## 前置条件

- Windows + [Node.js](https://nodejs.org) 18+(三个工具均为纯 Node,零依赖);
- 对应桌面 App 已安装并**登录过一次**:Trae CN / WorkBuddy / Qoder CN(凭据只读复用,见各插件 README);
- ZCode(可选)与 [pi coding agent](https://github.com/badlogic/pi-mono)(可选)。

## 一、启动方式(核心设计)

服务**不注册开机自启**。打开 ZCode 或 pi **任一应用**时自动拉起:

- ZCode 侧:每个插件的 `SessionStart` hook 探测端口,不在则静默拉起;
- pi 侧:`pi-connect-services` 扩展在 pi 启动时做同样的事。

手动兜底:`node <插件>/bin/cli.mjs serve --port <端口>`。

## 二、接入 ZCode

`%USERPROFILE%\.zcode\cli\config.json` 的 `plugins.dirs` 加入三个插件目录(按你的 clone 路径调整):

```jsonc
{
  "plugins": {
    "dirs": [
      "D:/path/to/zcode-ai-connect/zcode-workbuddy-connect",
      "D:/path/to/zcode-ai-connect/zcode-trae-connect",
      "D:/path/to/zcode-ai-connect/zcode-qoder-connect"
    ]
  }
}
```

托盘退出并重开 ZCode。首次每个插件执行一次(写入模型注册表):

```sh
node <插件>/bin/cli.mjs setup      # 仅 trae / workbuddy 需要;qoder 开箱即用
```

模型选择器中出现 WorkBuddy / Trae / Qoder 分组。

## 三、接入 pi

```sh
# 1. 安装启动扩展(打开 pi 自动拉起三个端点)
pi install D:/path/to/zcode-ai-connect/pi-connect-services

# 2. 生成/刷新 pi 的供应商与模型名册(从三个端点实时拉取,含思考档位映射)
node D:/path/to/zcode-ai-connect/sync-pi-models.mjs
```

之后在 pi 里 `/model` 选 `WB ·` / `Trae ·` / `Qoder ·` 前缀的模型,或 `pi --model workbuddy/deepseek-v4.1-flash` 直接指定。上游名册变化或端点 token 轮换(报 401)时,重跑一次 `sync-pi-models.mjs` 即可。

## 四、各家速览

| | WorkBuddy | Trae CN | Qoder CN |
|---|---|---|---|
| 端口 | 39271 | 39272 | 39270 |
| 凭据 | 桌面登录(只读) | 桌面登录(只读,自动刷新) | 桌面登录(只读)或 PAT |
| 协议 | OpenAI 透传网关 | llm_utils_chat(messages 直发) | COSY 签名 + WAF 编码 |
| system 保真 | ✅ 零注入 | ✅ 实测零注入 | ⚠️ 前后包夹身份锁(详见其 README) |
| 工具调用 | ✅ 回传调用方 | ✅ 回传调用方 | ✅ 回传调用方 |
| 特色 | 每日自动签到 | 1M max 窗口 · 双版本 | 免费档模型 · 可读模型 id |
| 常见坑 | 额度为 0 时限免模型仍可用 | 账号并发上限 2 会话(429 自愈) | 桌面 dt- ~16 天过期,开一次 App 刷新 |

各插件的完整文档(排障、命令、协议细节):[zcode-trae-connect](zcode-trae-connect/) · [zcode-workbuddy-connect](zcode-workbuddy-connect/) · [zcode-qoder-connect](zcode-qoder-connect/)

## 目录

```
zcode-ai-connect/
├── zcode-trae-connect/       # Trae CN 接入(llm_utils_chat 通道)
├── zcode-workbuddy-connect/  # WorkBuddy 接入(含每日签到)
├── zcode-qoder-connect/      # Qoder CN 接入(双轨凭据)
├── pi-connect-services/      # pi 启动扩展:自动拉起三个端点
└── sync-pi-models.mjs        # pi 供应商/名册同步脚本
```

## 免责与致谢

- 三款桌面 App 的接口均为非公开协议,来自社区逆向,随时可能变动;本项目仅限个人学习使用,请遵守各 App 的服务条款。
- 协议来源与致谢:Trae 通道源自 [dsh-trae-connect](https://github.com/marsma-101/dsh-trae-connect)(MIT)与 Trae2api-cn 的协议文档;WorkBuddy 源自 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)(MIT);Qoder 源自 [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect)(MIT)。本仓库在这些协议基础上做了移植、实测修正与功能扩展(消息保真、工具调用回传、模型别名、排队自愈等)。

MIT License — 见 [LICENSE](LICENSE)。
