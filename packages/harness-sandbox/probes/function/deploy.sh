#!/bin/sh
# Deploy the P0.1/P0.2 probe Function to a scratch project, from a temp
# directory (never from the repo, so nothing else is uploaded):
#
#   sh probes/function/deploy.sh <scratch-project> <team>
#   vercel curl "/api/hold?hold=780" --deployment <url> --scope <team> -- -sN -X POST
#
# It refuses a project without deployment protection (the Function boots a VM
# per request), and deletes its temp directory on exit: `vercel link` writes
# a .env.local there with a development OIDC token. Delete the project when
# done: vercel project rm <scratch-project> --scope <team>
set -eu
project=${1:?scratch project name}
team=${2:?team slug}
here=$(cd "$(dirname "$0")" && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp -R "$here/api" "$here/vercel.json" "$here/package.json" "$dir/"
cp "$here/../vm/echo-server.js" "$dir/echo-server.js"
cd "$dir"
vercel link --yes --project "$project" --scope "$team" >/dev/null
protection=$(vercel api "/v9/projects/$project" --scope "$team" 2>/dev/null | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{const p=JSON.parse(s);console.log(p.ssoProtection?.deploymentType??"none")})')
if [ "$protection" = none ]; then
  echo "refusing: $project has no deployment protection" >&2
  exit 1
fi
vercel deploy --yes --target preview --scope "$team"
