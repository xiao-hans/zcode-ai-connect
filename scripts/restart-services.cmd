@echo off
rem Restart the three local services this suite depends on.
rem Idempotent: a healthy service is skipped, a dead one is spawned detached.
rem
rem   :39268  codex-responses-bridge  (Claude Code / Codex protocol bridge)
rem   :39272  trae endpoint
rem   :39271  workbuddy endpoint
rem
rem Usage: double-click, or from any terminal:
rem   D:\HANXIAO\tools\zcode-ai-connect\scripts\restart-services.cmd
rem
rem Why a separate script: these are long-lived processes and must be started
rem from YOUR terminal or host app. Children spawned from an automation session
rem get reaped when that call ends -- the symptom is "started on :39268"
rem followed by 503 connect-refused seconds later.
rem
rem NOTE: keep this file ASCII-only. cmd.exe reads .cmd with the OEM codepage
rem (936 on zh-CN); UTF-8 Chinese comments get mis-decoded into stray commands.

node "%~dp0codex-responses-bridge.mjs" ensure
node "%~dp0..\zcode-trae-connect\hooks\service-ensure.mjs"
node "%~dp0..\zcode-workbuddy-connect\hooks\service-ensure.mjs"

echo.
echo --- listening ---
netstat -ano | findstr /R /C:"127.0.0.1:3926" /C:"127.0.0.1:3927"
