' Arranca el servidor de Martu Resto Bar SIN ventana (no se puede cerrar por error).
' Si se cae, INICIAR.bat lo vuelve a levantar solo. Para detenerlo: DETENER-SERVIDOR.bat
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Environment("Process")("MARTU_OCULTO") = "1"
sh.Run "cmd /c """ & dir & "\INICIAR.bat""", 0, False
