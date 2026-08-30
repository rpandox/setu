# Setu shell integration (zsh) — OSC 133 prompt marks, OSC 7 cwd, OSC 633;E command text.
# Safe to source twice; does nothing outside an interactive zsh.
[[ -o interactive ]] || return 0
(( ${+functions[__setu_precmd]} )) && return 0
__setu_osc() { printf '\e]%s\a' "$1"; }
__setu_cwd() { __setu_osc "7;file://${HOST}${PWD}"; }
__setu_preexec() {
  local cmd="${1//\\/\\\\}"; cmd="${cmd//;/\\x3b}"; cmd="${cmd//$'\n'/\\x0a}"
  __setu_osc "633;E;${cmd}"
  __setu_osc "133;C"
}
__setu_precmd() {
  local code=$?
  if [[ -n ${__setu_ran:-} ]]; then __setu_osc "133;D;${code}"; fi
  __setu_ran=1
  __setu_cwd
  __setu_osc "133;A"
}
__setu_zle_line_init() { __setu_osc "133;B"; }
autoload -Uz add-zsh-hook
add-zsh-hook precmd __setu_precmd
add-zsh-hook preexec __setu_preexec
add-zsh-hook chpwd __setu_cwd
if (( ${+functions[zle-line-init]} )); then
  functions[__setu_orig_zle_line_init]=$functions[zle-line-init]
  zle-line-init() { __setu_orig_zle_line_init "$@"; __setu_zle_line_init; }
else
  zle-line-init() { __setu_zle_line_init; }
fi
zle -N zle-line-init
