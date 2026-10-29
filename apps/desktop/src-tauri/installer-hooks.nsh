; Create the per-user drop folder on fresh installation and update.
; Never remove or replace existing projects, settings, or account connections.
!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$LOCALAPPDATA\Lemlio\Projects\Imports"
  CreateDirectory "$LOCALAPPDATA\Lemlio\Projects\Archives"
!macroend
