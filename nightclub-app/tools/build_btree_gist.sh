#!/usr/bin/env bash
# Build btree_gist contrib module into the pgserver-bundled PostgreSQL install.
# Required once per machine: the bundled PG 16.2 lacks contrib extensions.
# Usage: bash tools/build_btree_gist.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PGINSTALL="${PGINSTALL_DIR:-}"
if [ -z "$PGINSTALL" ]; then
  PGINSTALL=$(uv run --no-project --python 3.12 --with pgserver python -c \
    "import pgserver,os;print(os.path.join(os.path.dirname(pgserver.__file__),'pginstall'))")
fi
echo "PGINSTALL=$PGINSTALL"
if [ -f "$PGINSTALL/share/postgresql/extension/btree_gist.control" ]; then
  echo "btree_gist already installed"; exit 0
fi

VER=$("$PGINSTALL/bin/pg_config" --version | grep -oE '[0-9]+\.[0-9]+' | head -1)
MAJOR=${VER%%.*}
SRC="/tmp/postgresql-${VER}"
if [ ! -d "$SRC/contrib/btree_gist" ]; then
  TARBALL="/tmp/postgresql-${VER}.tar.gz"
  [ -f "$TARBALL" ] || curl -sSL -o "$TARBALL" "https://ftp.postgresql.org/pub/source/v${VER}/postgresql-${VER}.tar.gz"
  tar xzf "$TARBALL" -C /tmp "postgresql-${VER}/contrib/btree_gist"
fi
make -C "$SRC/contrib/btree_gist" USE_PGXS=1 PG_CONFIG="$PGINSTALL/bin/pg_config"
install -m 755 "$SRC/contrib/btree_gist/btree_gist.so" "$PGINSTALL/lib/postgresql/"
install -m 644 "$SRC/contrib/btree_gist/btree_gist.control" "$PGINSTALL/share/postgresql/extension/"
install -m 644 "$SRC/contrib/btree_gist"/btree_gist--*.sql "$PGINSTALL/share/postgresql/extension/"
echo "btree_gist installed into $PGINSTALL"
