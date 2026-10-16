#!/bin/bash
# Codex's bubblewrap sandbox as a cap-less, non-sudo user on the Drive (the
# `agent` user's case, P0.10). Run after bwrap-on-drive.sh, which installs
# Codex and creates the user. Can the sandboxed command write the Drive but
# not CODEX_HOME, and is PID 1's environ hidden?
C=/opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex
UH="/home/codexu"   # the second user's home
sudo chown -R codexu:codexu /workspace
echo "== codexu via sudo (no caps), bwrap :workspace on the drive"
sudo -u codexu env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=$UH CODEX_HOME=$UH/ch sh -c "mkdir -p $UH/ch && cd /workspace && $C sandbox -P :workspace -C /workspace -- sh -c 'echo hi2 > /workspace/from-codexu && echo wrote-drive-ok; mkdir -p /workspace/d && echo ok > /workspace/d/f && echo mkdir-ok; echo x > $UH/ch/evil 2>/dev/null && echo CODEX_HOME-WRITABLE || echo codex-home-blocked; cat /proc/1/environ >/dev/null 2>&1 && echo pid1-env-READABLE || echo pid1-env-blocked; ls /proc | grep -c ^[0-9]; sudo -n true 2>/dev/null && echo SUDO-OK || echo no-sudo'" 2>&1 | grep -v 'PATH aliases\|bubblewrap on PATH' | tail -8
ls -la /workspace /workspace/d
echo "== codexu danger-full-access sudo check"
sudo -u codexu sudo -n true 2>/dev/null && echo codexu-has-sudo || echo codexu-no-sudo
