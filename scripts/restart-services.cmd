@echo off
rem 一键拉起/确认本套件的三个本地服务(幂等:健康的直接跳过,不健康的 detached 拉起)。
rem
rem   :39268  codex-responses-bridge  —— Claude Code / Codex 的协议桥
rem   :39272  trae 端点
rem   :39271  workbuddy 端点
rem
rem 用法(任意终端,或双击):
rem   D:\HANXIAO\tools\zcode-ai-connect\scripts\restart-services.cmd
rem
rem 为什么要单独一个脚本:这三个服务是常驻进程,必须由**你自己的终端/宿主**
rem 拉起。从自动化会话里 spawn 出来的子进程会随会话被回收,表现为
rem "刚说 started 就 503 connect-refused"。

node "%~dp0codex-responses-bridge.mjs" ensure
node "%~dp0..\zcode-trae-connect\hooks\service-ensure.mjs"
node "%~dp0..\zcode-workbuddy-connect\hooks\service-ensure.mjs"

echo.
echo --- listening ---
netstat -ano | findstr /R /C:"127.0.0.1:3926" /C:"127.0.0.1:3927"
