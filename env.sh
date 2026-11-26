# source this file to enable the project-local toolchain (no root, nothing outside the project)
export DEVTERM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
export RUSTUP_HOME="$DEVTERM_ROOT/toolchain/rustup"
export CARGO_HOME="$DEVTERM_ROOT/toolchain/cargo"
export PATH="$DEVTERM_ROOT/toolchain/zig:$CARGO_HOME/bin:$PATH"
