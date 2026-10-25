# pi-connect-services

pi 启动时自动拉起本地模型端点(qoder / workbuddy / trae 三家 connect 工具)。

ZCode 侧由各插件的 SessionStart hook 负责同样的事;装上这个扩展后,**打开 pi 或 ZCode 任一应用**,整套端点栈就绪。

## 行为

- pi 启动 → 逐个探测 `127.0.0.1:39270/39271/39272` 的 `/healthz`;
- 已在跑 → 跳过;不在 → detached 静默拉起(`node <工具>/bin/cli.mjs serve --port N`);
- 全程 best-effort:拉起失败不影响 pi 会话,失败会体现在对应 provider 的连接错误里。

## 安装

```sh
pi install /path/to/pi-connect-services
```

## 配置

端点工具根目录默认为本扩展所在目录的上一级(即套件仓库根),可用环境变量覆盖:

```
PI_CONNECT_TOOLS_ROOT=D:/your/tools/root
```

(其下应存在 `zcode-qoder-connect`、`zcode-workbuddy-connect`、`zcode-trae-connect` 三个目录。)

MIT。
