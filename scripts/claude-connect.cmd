@echo off
rem Claude Code → zcode-ai-connect 本地桥(127.0.0.1:39268)。
rem 用 --settings 会话级覆盖接入,不读不改 ~/.claude 的登录态与 settings.json env
rem (settings.json 里的 ANTHROPIC_BASE_URL 优先级高于 shell 环境变量,shell 传参压不过它,
rem  所以必须走 --settings 这一层)。用法与 claude 完全一致:
rem   claude-connect [-p "…"] [--dangerously-skip-permissions] ...
node "%~dp0codex-responses-bridge.mjs" ensure >nul 2>&1
claude --settings "%~dp0claude-connect-settings.json" %*
