Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d %USERPROFILE%\Desktop\PROA_WEB && py app_web.py", 0, False
