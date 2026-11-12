@echo off
rem teapot-agent
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:18765/api/shutdown -Headers @{'X-Teapot-Agent'='1'} -ContentType 'application/json' -Body '{}' | Out-Null; 'stopped' } catch { 'not running' }"
