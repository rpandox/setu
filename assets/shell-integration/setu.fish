# Setu shell integration (fish) — OSC 133 prompt marks, OSC 7 cwd, OSC 633;E command text.
# Safe to source twice; does nothing outside an interactive fish.
if status is-interactive; and not functions -q __setu_precmd
  function __setu_osc; printf '\e]%s\a' $argv[1]; end
  function __setu_cwd --on-variable PWD; __setu_osc "7;file://$hostname$PWD"; end
  function __setu_preexec --on-event fish_preexec
    set -l cmd (string replace -a '\\' '\\\\' -- $argv[1] | string replace -a ';' '\\x3b' | string join '\\x0a')
    __setu_osc "633;E;$cmd"
    __setu_osc "133;C"
    set -g __setu_ran 1
  end
  function __setu_precmd --on-event fish_prompt
    set -l code $status
    if set -q __setu_ran; __setu_osc "133;D;$code"; end
    set -g __setu_ran 1
    __setu_cwd
    __setu_osc "133;A"
  end
  function __setu_postprompt --on-event fish_postprompt; __setu_osc "133;B"; end
end
