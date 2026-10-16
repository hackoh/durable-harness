#!/bin/bash
# `codex app-server --listen ws://` inside a VM, behind its capability-token
# auth (the debug transport in docs/workspaces.md §5.4). The client keeps the
# token; only its sha256 reaches the VM:
#   T=$(openssl rand -hex 32); H=$(printf %s "$T" | sha256sum | cut -d" " -f1)
#   (in the VM, port 4500 exposed) bash start-app-server.sh "$H"
#   (on the laptop) node ws-client.mjs wss://<sandbox domain for 4500> "$T"
# Never commit a token or its hash.
set -e
TOKEN_SHA256=${1:?sha256 of the client token}
CH=$HOME/ch2
mkdir -p $CH /tmp/w
cat > $CH/config.toml <<'TOML'
model = "openai/gpt-5.4-mini"
model_provider = "gateway"
model_context_window = 272000
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false

[model_providers.gateway]
name = "AI Gateway"
base_url = "http://127.0.0.1:4601/v1"
env_key = "HARNESS_CODEX_GATEWAY_KEY"
wire_api = "responses"
supports_websockets = false

[features]
shell_tool = true
unified_exec = true
plugins = false
apps = false
hooks = false
daemon_auto_start = false

[analytics]
enabled = false
TOML
cd /tmp/w
CODEX_HOME=$CH HARNESS_CODEX_GATEWAY_KEY=x setsid -f setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- /opt/codex/vendor/x86_64-unknown-linux-musl/bin/codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-sha256 "$TOKEN_SHA256" > /tmp/appserver.log 2>&1 < /dev/null
sleep 2
head -20 /tmp/appserver.log
curl -s -o /dev/null -w "readyz=%{http_code}\n" http://127.0.0.1:4500/readyz
