/**
 * The remote sampler for `node monitor --watch`. The CLI ships this self-contained
 * bash over SSM each interval; it prints ONE `launchpad.stats` JSON line (the exact
 * shape the agent emits), so the same `parseStatsLine` reads both CloudWatch history
 * and a live sample. It depends only on `/proc`, `awk`, `date`, and `docker` — never
 * on the on-box agent version. Host stats always print; docker failures degrade the
 * `services` array to `[]` rather than failing the whole sample.
 */

import { LABELS } from "@agentsystemlabs/launch-pad-shared";

/** Build the remote bash. `nodeId` is a validated DNS label, but reject quotes defensively. */
export function renderStatsSampleScript(nodeId: string): string {
  if (nodeId.includes("'") || nodeId.includes("\n")) {
    throw new Error(`unsafe node id for remote sampling: ${JSON.stringify(nodeId)}`);
  }
  const managed = `${LABELS.managed}=true`;
  const labelTpl = `{{.Id}}|{{index .Config.Labels "${LABELS.project}"}}|{{index .Config.Labels "${LABELS.service}"}}|{{index .Config.Labels "${LABELS.replica}"}}|{{.HostConfig.NanoCpus}}`;

  return `#!/bin/bash
set -uo pipefail
NODE_ID='${nodeId}'
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

read_cpu() { awk '/^cpu /{t=0; for (i=2;i<=NF;i++) t+=$i; print t, ($5+$6)}' /proc/stat; }
set -- $(read_cpu); t1=\${1:-0}; i1=\${2:-0}
sleep 0.3
set -- $(read_cpu); t2=\${1:-0}; i2=\${2:-0}
cpu=$(awk -v t1="$t1" -v i1="$i1" -v t2="$t2" -v i2="$i2" 'BEGIN{dt=t2-t1; di=i2-i1; v=(dt<=0)?0:(1-di/dt)*100; if(v<0)v=0; if(v>100)v=100; printf "%.1f", v}')

read mem_used mem_total <<EOF
$(awk '/^MemTotal:/{tot=$2} /^MemAvailable:/{av=$2} END{u=tot-av; if(u<0)u=0; printf "%d %d", u/1024, tot/1024}' /proc/meminfo)
EOF

services="[]"
if command -v docker >/dev/null 2>&1; then
  ids=$(docker ps --filter label=${managed} -q 2>/dev/null || true)
  if [ -n "$ids" ]; then
    meta=$(docker inspect --format '${labelTpl}' $ids 2>/dev/null || true)
    stat=$(docker stats --no-stream --no-trunc --format '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}' $ids 2>/dev/null || true)
    services=$(awk -F'|' '
      NR==FNR { if ($0=="") next; id=$1; proj[id]=$2; svc[id]=$3; rep[id]=$4; nano[id]=$5; ord[++n]=id; next }
      {
        if ($0=="") next;
        sid=$1; c=$2; gsub(/%/,"",c); scpu[sid]=c+0;
        split($3, mm, "/"); smu[sid]=tomb(mm[1]); sml[sid]=tomb(mm[2]);
        sids[++sn]=sid;
      }
      function tomb(s,   v,u) {
        gsub(/^[ \\t]+|[ \\t]+$/,"",s);
        if (match(s,/[0-9.]+/)) v=substr(s,RSTART,RLENGTH)+0; else return 0;
        u=s; sub(/[0-9.]+/,"",u); gsub(/[ \\t]/,"",u); u=toupper(u);
        if(u=="B") return v/1048576;
        if(u=="KIB"||u=="KB") return v/1024;
        if(u=="MIB"||u=="MB") return v;
        if(u=="GIB"||u=="GB") return v*1024;
        if(u=="TIB"||u=="TB") return v*1048576;
        return 0;
      }
      function findstat(id,   i,s) { for(i=1;i<=sn;i++){ s=sids[i]; if(index(id,s)==1||index(s,id)==1) return s } return "" }
      END {
        out="["; first=1;
        for (k=1;k<=n;k++) {
          id=ord[k]; s=findstat(id);
          cpus=nano[id]/1000000000;
          raw=(s!="")?scpu[s]:0;
          v=(cpus>0)?raw/cpus:raw; if(v<0)v=0; if(v>100)v=100;
          u=(s!="")?smu[s]:0; l=(s!="")?sml[s]:0;
          if(!first) out=out","; first=0;
          out=out sprintf("{\\"project\\":\\"%s\\",\\"service\\":\\"%s\\",\\"replica\\":%d,\\"cpuPercent\\":%.1f,\\"memoryUsedMb\\":%d,\\"memoryLimitMb\\":%d}", proj[id], svc[id], rep[id]+0, v, int(u+0.5), int(l+0.5));
        }
        print out"]";
      }
    ' <(printf '%s\\n' "$meta") <(printf '%s\\n' "$stat"))
    [ -z "$services" ] && services="[]"
  fi
fi

printf '{"event":"launchpad.stats","nodeId":"%s","ts":"%s","host":{"cpuPercent":%s,"memoryUsedMb":%s,"memoryTotalMb":%s},"services":%s}\\n' "$NODE_ID" "$ts" "\${cpu:-0}" "\${mem_used:-0}" "\${mem_total:-0}" "$services"
`;
}
