#!/usr/bin/env bash
# 检查“润色”是否只动了注释/空行：把两版文件的 diff 里所有非注释的改动行列出来。
# C/H 不做文本判断，最终用编译产物哈希兜底。
set -u
BASE="C:/Users/LENOVO/AppData/Local/Temp/shouchao-polish/baseline"
ROOT="D:/OpenHarmony/competition"
fail=0

while IFS= read -r old; do
  rel="${old#$BASE/}"
  case "$rel" in
    bridge/_test/*) continue ;;
  esac
  ext="${rel##*.}"
  case "$ext" in
    c|h) continue ;;
    js|ets|ts|ps1) ;;
    *) continue ;;
  esac
  new="$ROOT/$rel"
  [ -f "$new" ] || { echo "MISSING $rel"; fail=1; continue; }
  cmp -s "$old" "$new" && continue

  if [ "$ext" = "ps1" ]; then
    suspicious="$(diff -u "$old" "$new" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
      | sed -E 's/^[+-]//' | grep -vE '^[[:space:]]*(#|<#|#>|$)' || true)"
  else
    suspicious="$(diff -u "$old" "$new" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
      | sed -E 's/^[+-]//' | grep -vE '^[[:space:]]*(//|/\*|\*|\*/|$)' || true)"
  fi

  if [ -n "$suspicious" ]; then
    echo "CHECK $rel"
    printf '%s\n' "$suspicious" | head -40
    fail=1
  else
    echo "OK    $rel"
  fi
done < <(find "$BASE" -type f | sort)

exit $fail
