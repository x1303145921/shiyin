' 启动拾音.vbs —— 隐藏窗口启动拾音服务（工具箱快捷方式指向本文件）
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = WScript.CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
ws.Run """" & base & "\启动拾音.bat""", 0, False