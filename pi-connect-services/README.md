# pi-connect-services

pi 启动时自动拉起本地模型端点(qoder / workbuddy / trae 三家 connect 工具)。

ZCode 侧由各插件的 SessionStart hook 负责同样的事;装上这个扩展后,**打开 pi 或 ZCode 任一应用**,整套端点栈就绪。

## 行为

- pi 启动 → 逐个探测 `127.0.0.1:39270/39271/39272` 的 `/healthz`;
- 已在跑 → 跳过;不在 → detached 静默拉起(`node <工具>/bin/cli.mjs serve --port N`);
- 全程 best-effort:拉起失败不影响 pi 会话,失败会体现在对应 provider 的连接错误里。

## 收尾守卫

同一个扩展还挂在 `agent_before_settle` 上，模型**什么都没给就收工**时补一轮：

| 场景 | 是否续跑 | 说明 |
|---|---|---|
| 空回合（只有 thinking，正文为空、无工具） | 是 | 所有 provider 都管 |
| stall：宣布了下一步却没动手 | 是 | 仅限没有自带守卫的 provider |
| stall 且 provider=qwenwork | 否 | 交给 pi-provider-qwenwork，不塞两条提示 |
| 用户中断 / 出错的回合 | 否 | `outcome !== 'completed'` |
| 本轮已经调过工具 | 否 | 不存在「只说不做」 |

同一条用户输入之后最多续跑 2 次，用户一发新消息预算重置。

为什么放在这个扩展而不是 pi-provider-qwenwork：后者在 `startChatShim()` 失败时
直接 `return`，没装/没登录 qwenwork 时守卫会整体消失 —— 而那正是只用
trae / workbuddy / qoder 时的常态。

## 安装

```sh
pi install npm:pi-connect-services
```

三个 connect 工具(`zcode-qoder-connect`、`zcode-workbuddy-connect`、`zcode-trae-connect`)是本包的依赖,会一并装上,**无需额外配置**。

也可以装本地副本(例如套件仓库里的开发版):

```sh
pi install /path/to/pi-connect-services
```

## 工具定位顺序

扩展按顺序找每个工具目录,第一个含 `bin/cli.mjs` 的胜出:

1. `PI_CONNECT_TOOLS_ROOT` —— 显式覆盖,优先级最高;
2. npm 依赖 —— `pi install npm:` 时的默认路径,开箱即用;
3. 兄弟目录布局 —— 本扩展上一级下的 `<tool>`,即套件仓库 checkout 的形状。

三个都找不到时,启动日志会出现一条 `FAILED — <tool> not found` 警告(而不是静默失败)。

## 配置

通常不需要。只有当你想让 npm 安装的扩展去拉起**套件仓库里的开发版**工具时,才设:

```
PI_CONNECT_TOOLS_ROOT=D:/your/suite/repo
```

(其下应存在 `zcode-qoder-connect`、`zcode-workbuddy-connect`、`zcode-trae-connect` 三个目录。)

MIT。
