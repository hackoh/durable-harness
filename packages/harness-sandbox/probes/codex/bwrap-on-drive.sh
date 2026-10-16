#!/bin/bash
# Codex's bubblewrap sandbox on a Drive (P0.10's first half; run inside a VM
# with a Drive at /workspace, as the default user). Installs the pinned Codex
# Linux build under /opt/codex, then runs `codex sandbox -P :workspace` with
# every capability dropped: can the sandboxed command write the Drive, and is
# /etc still read-only? Then the same as a second user without caps.
#   CODEX_VERSION=0.160.0 bash bwrap-on-drive.sh
grep -E ' /workspace' /proc/self/mounts; ls -ld /workspace; df -h /workspace | tail -1; id
set -e
sudo mkdir -p /opt/codex && sudo chown $(id -u):$(id -g) /opt/codex
curl -fsSL -o /tmp/codex.tgz "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION:-0.160.0}-linux-x64.tgz"
tar xzf /tmp/codex.tgz -C /opt/codex --strip-components=1 --exclude='package/vendor/*/codex-resources/voice'
set +e
C=/opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex
UH="/home/codexu"   # the second user's home
mkdir -p $HOME/ch; export CODEX_HOME=$HOME/ch
echo "== bwrap :workspace with cwd=/workspace (drive)"
setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- $C sandbox -P :workspace -C /workspace -- sh -c 'echo hi > /workspace/from-sandbox && echo wrote-drive-ok; mkdir -p /workspace/d && echo ok > /workspace/d/f && echo mkdir-ok; echo x > /etc/x 2>/dev/null && echo ESCAPED || echo etc-blocked' 2>&1 | grep -v 'PATH aliases\|bubblewrap on PATH' | tail -5
ls -la /workspace
echo "== a second user (codex), caps dropped"
sudo useradd -m -s /bin/bash codexu 2>/dev/null; sudo chown -R codexu:codexu /workspace 2>&1 | tail -1
sudo -u codexu setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- env HOME=$UH CODEX_HOME=$UH/ch sh -c "mkdir -p $UH/ch && $C sandbox -P :workspace -C /workspace -- sh -c 'echo hi2 > /workspace/from-codexu && echo wrote-as-codexu; cat /proc/1/environ >/dev/null 2>&1 && echo pid1-env-READABLE || echo pid1-env-blocked'" 2>&1 | grep -v 'PATH aliases\|bubblewrap on PATH' | tail -4
grep -E '^Cap(Eff|Amb)' /proc/self/status
sudo -u codexu grep -E '^Cap(Eff|Amb)' /proc/self/status
