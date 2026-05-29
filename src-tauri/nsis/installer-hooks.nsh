; Harness Studio NSIS installer hooks
; Adds an "Uninstall Harness Studio" shortcut inside the Start Menu folder
; during install, and removes it before uninstall so Tauri's RMDir can
; delete the now-empty folder cleanly.

!macro NSIS_HOOK_POSTINSTALL
  ; Only create shortcuts in a full install (not a silent update / repair)
  ${If} $UpdateMode <> 1
  ${AndIf} $NoShortcutMode <> 1
    CreateShortcut \
      "$SMPROGRAMS\$AppStartMenuFolder\Uninstall ${PRODUCTNAME}.lnk" \
      "$INSTDIR\uninstall.exe"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Resolve the Start Menu folder name from registry, then delete the
  ; uninstall shortcut BEFORE Tauri's cleanup block runs RMDir so the
  ; folder is empty and gets removed correctly.
  ${If} $UpdateMode <> 1
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    Delete "$SMPROGRAMS\$AppStartMenuFolder\Uninstall ${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend
