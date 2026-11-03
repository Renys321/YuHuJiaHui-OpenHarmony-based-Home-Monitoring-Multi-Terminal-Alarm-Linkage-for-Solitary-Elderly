#!/bin/sh
# ============================================================================
#  say.sh —— 求助语音播报启动脚本（板端）
#
#  由南向守护进程 homemon 在触发告警时调用：
#      homemon.conf:  say_cmd=/data/homemon/say.sh "%s"
#  其中 %s 会被替换为播报文本（当前预录音频不含文本，参数仅作日志用途）。
#
#  实际动作：拉起北向 APP 的独立语音 Ability，播放随包携带的 sos.wav。
#  为什么用 `aa start` 而不是在 homemon 里直接放音：
#    音频通路需要 OpenHarmony 的应用媒体能力（AVPlayer + 音频策略），
#    由应用侧 Ability 播放最稳，且能与 APP 的告警处置逻辑共用一套资源。
#
#  日志：/data/homemon/say.log（便于真机排查"到底有没有被调用"）
# ============================================================================
TEXT="$1"
STAMP=$(date '+%Y-%m-%d %H:%M:%S')
DIR="$(dirname "$0")"

echo "$STAMP  say.sh 被调用，文本: $TEXT" >> "$DIR/say.log" 2>/dev/null

# 拉起语音 Ability（APP 需已安装；未安装时此处会失败，日志里能看到）
OUT=$(aa start -a SosVoiceAbility -b com.dsh.eldercare 2>&1)
rc=$?
echo "$STAMP  aa start 结果(rc=$rc): $OUT" >> "$DIR/say.log" 2>/dev/null

# 兜底：板上若有蜂鸣器/提示音命令，可在此追加（预留）

# ⚠ 必须返回真实退出码：否则 homemon 的 system() 永远得到 0，
#   播报失败也不会被记录（真机排查时会被误导）。
exit "$rc"
