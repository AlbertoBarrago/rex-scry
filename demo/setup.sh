#!/bin/sh
# Creates the synthetic project the demo records (never a real repository).
# Prints its path. Usage: dir=$(sh demo/setup.sh)
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
base="${TMPDIR:-/tmp}/rex-diagnostics-demo"
rm -rf "$base"
mkdir -p "$base/app/src" "$base/state" "$base/bin"
# The demo's editor: the real nvim without the user's config, with this repo's
# plugin loaded. Named nvim so `open` passes it the column too.
nvim_bin=$(command -v nvim)
cat > "$base/bin/nvim" <<SH
#!/bin/sh
exec "$nvim_bin" --clean --cmd "set rtp^=$repo/nvim" --cmd "set number cursorline" "\$@"
SH
chmod +x "$base/bin/nvim"
cd "$base/app"
git init -q .
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "NodeNext", "types": [] }, "include": ["src"] }
JSON
cat > src/user.ts <<'TS'
export interface User {
  id: number;
  name: string;
}

export function displayName(users: User[], id: number): string {
  const user = users.find((u) => u.id === id);
  return user.name;
}
TS
cat > src/api.ts <<'TS'
interface Session {
  token: string;
}

export function sessionId(session: Session): string {
  return session.id;
}
TS
cat > src/config.ts <<'TS'
export const port: number = "3000";
TS
printf '%s\n' "$base"
