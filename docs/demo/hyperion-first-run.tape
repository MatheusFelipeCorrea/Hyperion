# Hyperion first-run CLI demo (Charm VHS).
# From repo root:
#   docker run --rm -v "${PWD}:/work" -w /work ghcr.io/charmbracelet/vhs docs/demo/hyperion-first-run.tape
# Output: docs/demo/hyperion-first-run.gif

Output docs/demo/hyperion-first-run.gif
Set FontSize 15
Set Width 1080
Set Height 640
Set Padding 14
Set Theme "Catppuccin Mocha"
Set TypingSpeed 28ms
Set Shell "bash"

Hide
Type `clear`
Enter
Show

Type `# Hyperion first-run — doctor → language → gates → process-guard`
Enter
Sleep 800ms

Type `npm run hyperion:detect-language -- --no-gh`
Enter
Sleep 2500ms

Type `npm run hyperion:process-guard -- --status`
Enter
Sleep 2000ms

Type `npm run hyperion:pipeline-gates -- --json | head -n 24`
Enter
Sleep 3500ms

Type `# Next: /setup or npm run hyperion:create, then /pipeline --refresh-gates`
Enter
Sleep 1800ms
