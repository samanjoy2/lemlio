; Create the per-user drop folder on fresh installation and update.
; Never remove or replace existing projects, settings, or account connections.
!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$LOCALAPPDATA\Lemlio\Projects\Imports"
  CreateDirectory "$LOCALAPPDATA\Lemlio\Projects\Archives"
  CreateDirectory "$APPDATA\com.lemlio.desktop\tools"
  IfFileExists "$APPDATA\com.lemlio.desktop\tools\runtime-v1.json" lemlio_runtime_done 0
  MessageBox MB_YESNO|MB_ICONQUESTION "Set up Lemlio's Python runtime now? This downloads Python into Lemlio's own tools folder. You can also do this later in Settings > Tools." /SD IDNO IDNO lemlio_runtime_done
  ExecWait '"$INSTDIR\prismpro-desktop.exe" --setup-tools-runtime' $0
  StrCmp $0 "0" lemlio_runtime_done
  MessageBox MB_OK "Python setup could not finish. Use Settings > Tools > Set up / Repair runtime after opening Lemlio." /SD IDOK
  lemlio_runtime_done:
!macroend
