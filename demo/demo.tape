# Demo recording for the README.
# Regenerate with:  npm run build && vhs demo/demo.tape
# Uses a synthetic project only (demo/setup.sh), never a real repository.

Output demo/rex-scry.gif
Output demo/rex-scry.mp4

Require nvim
Require jq

Set Shell zsh
Set FontSize 16
Set Width 1400
Set Height 820
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms
Set WindowBar Colorful
Set WindowBarSize 36

Hide
Type `d=$(TMPDIR=/tmp sh demo/setup.sh) && export PATH=$d/bin:$PWD/demo/bin:$PATH REX_SCRY_STATE_DIR=$d/state VISUAL=nvim EDITOR=nvim REX_SCRY_REX_NVIM= && unset REX_BLOCK && cd $d/app && PROMPT='%F{blue}app%f %F{magenta}❯%f ' && clear`
Enter
Sleep 2s
Show

Sleep 500ms
Type "rex-scry run -- tsc -p ."
Sleep 400ms
Enter
Sleep 3s

Type "rex-scry list"
Sleep 400ms
Enter
Sleep 4s

# The live panel: move, group by tool, back to files, quit.
Type "rex-scry ui"
Sleep 400ms
Enter
Sleep 3s
Type "j"
Sleep 900ms
Type "j"
Sleep 1.2s
Tab
Sleep 1.8s
Tab
Sleep 1.2s
Tab
Sleep 1.2s
Type "q"
Sleep 800ms

# Jump to the third one in Neovim, then load all of them into quickfix.
Type "rex-scry open 3"
Sleep 400ms
Enter
Sleep 2.5s
Type ":RexScry"
Sleep 400ms
Enter
Sleep 3s
Type ":cnext"
Enter
Sleep 2s
Type ":qa!"
Enter
Sleep 1s

# Fix one error and build again: the old diagnostics are replaced.
Type `clear && sed -i '' 's/user.name/user?.name ?? ""/' src/user.ts`
Sleep 400ms
Enter
Sleep 1s
Type "rex-scry run -- tsc -p ."
Sleep 400ms
Enter
Sleep 3s

Type "rex-scry list --json | jq -c .counts"
Sleep 400ms
Enter
Sleep 2.5s

Type "rex-scry next"
Sleep 300ms
Enter
Sleep 2.5s
