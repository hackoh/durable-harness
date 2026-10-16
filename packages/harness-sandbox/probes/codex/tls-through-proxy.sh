# Does Codex trust the sandbox network proxy's CA when a network-policy rule
# terminates TLS for its model host? (The research's round 4: a transform rule
# on httpbin.org, no real key.) Run inside a VM; prints the distinct TLS and
# status lines from Codex's debug log.
mkdir -p /tmp/cx && cd /tmp/cx
OPENAI_API_KEY=placeholder RUST_LOG=debug timeout 45 codex exec --skip-git-repo-check \
  -c model_provider=probe -c model_providers.probe.name=probe \
  -c model_providers.probe.base_url=https://httpbin.org/anything \
  -c model_providers.probe.env_key=OPENAI_API_KEY -c model_providers.probe.wire_api=responses \
  -c model_providers.probe.stream_max_retries=0 -c model_providers.probe.request_max_retries=0 \
  "say hi" > /tmp/cx/log 2>&1
echo "lines: $(wc -l < /tmp/cx/log)"
grep -i -o -E 'invalid ?certificate|unknown ?issuer|UnknownIssuer|certificate verify[a-z ]*|self.signed|tls handshake[a-z ]*|status: ?[0-9]{3}|200 OK|unexpected status[^,]{0,60}|stream disconnected[^.]{0,100}' /tmp/cx/log | sort | uniq -c | sort -rn | head -10
