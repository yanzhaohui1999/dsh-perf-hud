#!/bin/bash
# 重启后自动验证。用 setsid 起在独立进程组,所以 ai.dsh.web 重启不会带走它。
# 关键教训:token 每次重启都换 —— 必须**等 pid 变了之后**再去日志里读最新 token,
# 否则拿旧 token 换 cookie 只会一直 401(第一版就是这么栽的)。
exec >> /Users/y/workspace/dsh-perf-hud/live-verification.txt 2>&1
NODE=/Users/y/tools/node-v24.19.0-darwin-arm64/bin/node
REPO=/Users/y/workspace/dsh-perf-hud
OLD_PID=$(launchctl print gui/501/ai.dsh.web 2>/dev/null | awk '/^[[:space:]]+pid = /{print $3; exit}')
echo "===== $(date '+%F %T') 等待重启(旧 pid=$OLD_PID)====="
PID="$OLD_PID"
for i in $(seq 1 60); do
  sleep 5
  PID=$(launchctl print gui/501/ai.dsh.web 2>/dev/null | awk '/^[[:space:]]+pid = /{print $3; exit}')
  if [ -n "$PID" ] && [ "$PID" != "$OLD_PID" ]; then break; fi
done
echo "新 pid=$PID"
for attempt in $(seq 1 40); do
  TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' ~/Library/Logs/ai.dsh.web.log | sed 's/token=//' | tail -1)
  curl -s -D /tmp/verify-h.txt -o /dev/null -H "Host: 127.0.0.1:3080" "http://127.0.0.1:3080/?token=$TOKEN"
  COOKIE=$(grep -i '^set-cookie' /tmp/verify-h.txt | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)
  echo "  换 cookie 第 $attempt 次:token len=${#TOKEN} cookie len=${#COOKIE}"
  if [ -n "$COOKIE" ]; then break; fi
  sleep 3
done
for i in $(seq 1 45); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: 127.0.0.1:3080" -H "Cookie: $COOKIE" "http://127.0.0.1:3080/api/dsh-perf-hud/host")
  echo "  探活 $i:http=$CODE"
  if [ "$CODE" = "200" ]; then break; fi
  sleep 4
done
echo "===== $(date '+%F %T') live-host ====="
DSH_COOKIE="$COOKIE" "$NODE" "$REPO/tests/live-host.mjs"; echo "live-host exit=$?"
# 事件到达延迟需要"有回合在跑"才有数:重启后紧接着的会话活动会落进这个窗口。
echo "===== $(date '+%F %T') 轮询事件到达延迟(最多 180s)====="
for i in $(seq 1 36); do
  curl -s -X POST "http://127.0.0.1:3080/api/dsh-perf-hud/host" -H "Host: 127.0.0.1:3080" -H "Cookie: $COOKIE" -H 'Content-Type: application/json' -d '{"op":"watchEvents","enable":true}' > /dev/null
  S=$(curl -s -X POST "http://127.0.0.1:3080/api/dsh-perf-hud/host" -H "Host: 127.0.0.1:3080" -H "Cookie: $COOKIE" -H 'Content-Type: application/json' -d '{"op":"status"}' | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const st=j.host.eventWatch.stats;console.log(Object.keys(st).length?JSON.stringify(st):"{}")}catch(e){console.log("ERR")}})')
  echo "  第 $i 次: $S"
  if [ "$S" != "{}" ] && [ "$S" != "ERR" ]; then break; fi
  sleep 5
done
echo "===== $(date '+%F %T') live-sourcemap ====="
DSH_COOKIE="$COOKIE" "$NODE" "$REPO/tests/live-sourcemap.mjs"; echo "live-sourcemap exit=$?"
echo "===== $(date '+%F %T') 结束 ====="
