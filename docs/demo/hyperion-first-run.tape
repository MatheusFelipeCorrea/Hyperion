# Hyperion first-run CLI demo (Charm VHS).
# Generate GIF: docker run --rm -v ${PWD}/docs/demo:/vhs ghcr.io/charmbracelet/vhs hyperion-first-run.tape
# Requires Docker. Output: docs/demo/hyperion-first-run.gif

Output hyperion-first-run.gif
Set FontSize 16
Set Width 1100
Set Height 620
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Shell powershell

Hide
Type "clear"
Enter
Show

Type "# Hyperion — first-run (doctor → language → gates → process-guard)"
Enter
Type "npm run hyperion:doctor"
Enter
Sleep 4s

Type "npm run hyperion:detect-language -- --no-gh"
Enter
Sleep 2s

Type "npm run hyperion:pipeline-gates -- --json 2>$null | Select-Object -First 20"
Enter
Sleep 3s

Type "npm run hyperion:process-guard -- --status"
Enter
Sleep 2s

Type "# Next: /setup or hyperion:create, then /pipeline --refresh-gates"
Enter
Sleep 2s
