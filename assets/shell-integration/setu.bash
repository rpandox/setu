# Setu shell integration (bash) — OSC 133 prompt marks, OSC 7 cwd, OSC 633;E command text.
# Safe to source twice; does nothing outside an interactive bash.
[[ $- == *i* ]] || return 0
[[ -n ${__setu_loaded:-} ]] && return 0
__setu_loaded=1
__setu_osc() { printf '\033]%s\007' "$1"; }
__setu_cwd() { __setu_osc "7;file://${HOSTNAME}${PWD}"; }
__setu_preexec() {
  [[ -n ${COMP_LINE:-} ]] && return
  [[ -n ${__setu_in_prompt:-} ]] && return
  [[ ${BASH_COMMAND} == __setu_* ]] && return
  local cmd="${BASH_COMMAND//\\/\\\\}"; cmd="${cmd//;/\\x3b}"; cmd="${cmd//$'\n'/\\x0a}"
  __setu_osc "633;E;${cmd}"
  __setu_osc "133;C"
  __setu_in_cmd=1
}
__setu_precmd() {
  local code=$?
  __setu_in_prompt=1
  if [[ -n ${__setu_in_cmd:-} ]]; then __setu_osc "133;D;${code}"; __setu_in_cmd=; fi
  __setu_cwd
  __setu_osc "133;A"
}
__setu_prompt_end() { __setu_osc "133;B"; __setu_in_prompt=; }
if [[ ${PROMPT_COMMAND:-} != *__setu_precmd* ]]; then
  PROMPT_COMMAND="__setu_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
PS1="${PS1}\[$(printf '\033]133;B\007')\]"
trap '__setu_preexec' DEBUG
