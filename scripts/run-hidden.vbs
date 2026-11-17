' Runs the Model Chat auto-restart check (node scripts\tunnel.mjs ensure) with no visible window.
' Used by the "Model Chat auto-restart" scheduled task. Arguments: node.exe path, app folder, port.
Set args = WScript.Arguments
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = args(1)
WScript.Quit shell.Run("""" & args(0) & """ scripts\tunnel.mjs ensure --port " & args(2), 0, True)
