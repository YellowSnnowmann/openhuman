#!/bin/sh
# docker-entrypoint-core.sh — runtime entrypoint for the openhuman-core container.
#
# Problem: Docker named volumes are created owned root:root, even when the image
# has a non-root USER.  The first write openhuman-core makes after the banner
# (init_rpc_token → write_token_file → create_dir_all) hits EACCES and the
# process exits with code 1.
#
# Fix (gosu pattern):
#   1. Start as root so we can chown the mount point(s).
#   2. mkdir -p + chown the workspace directory *and everything inside it*
#      before any application code runs, so the openhuman user owns it
#      regardless of whether Docker created the volume as root.
#   3. exec gosu openhuman to drop privileges and hand off to the binary.
#
# The chown MUST be recursive.  Healing only the directory inode leaves any
# file inside it — most importantly `config.toml`, which the core writes at
# mode 0600 — owned by whichever uid created it.  A workspace volume that was
# seeded by an older image, restored from a backup, or written by a root
# `docker exec` therefore produced:
#
#   Failed to read config file: /home/openhuman/.openhuman/config.toml:
#   Permission denied (os error 13)
#
# on every config-dependent RPC (sign-in included) while the container kept
# answering /health with 200.
#
# This is idempotent: files already owned by the openhuman user are skipped, so
# a healthy re-used volume costs one `find` traversal.  No manual
# "docker volume rm" is required when upgrading from a previously broken image.
#
# Requirements: gosu must be installed in the image (see Dockerfile), and the
# container needs CAP_CHOWN + CAP_SETUID + CAP_SETGID.  A capability-denied
# chown is a warning, not a fatal error — the readability preflight below is
# what decides whether the core can actually start.
# POSIX sh — no bashisms.
set -e

OPENHUMAN_USER="openhuman"
OPENHUMAN_UID="$(id -u "${OPENHUMAN_USER}" 2>/dev/null || echo '')"
OPENHUMAN_GID="$(id -g "${OPENHUMAN_USER}" 2>/dev/null || echo '')"

# The workspace path the core will actually write to.
# Prefer the env var if set; otherwise fall back to the image default.
WORKSPACE_DIR="${OPENHUMAN_WORKSPACE:-/home/openhuman/.openhuman}"
# The home directory (where core.token is written when OPENHUMAN_CORE_TOKEN is
# unset — see src/core/auth.rs default_root_openhuman_dir()).
HOME_OPENHUMAN_DIR="/home/openhuman/.openhuman"

echo "[docker-entrypoint] uid=$(id -u), gid=$(id -g), user=$(id -un 2>/dev/null || echo unknown)"
echo "[docker-entrypoint] target user=${OPENHUMAN_USER} uid=${OPENHUMAN_UID} gid=${OPENHUMAN_GID}"
echo "[docker-entrypoint] WORKSPACE_DIR=${WORKSPACE_DIR}"
echo "[docker-entrypoint] HOME_OPENHUMAN_DIR=${HOME_OPENHUMAN_DIR}"

# An explicit non-root `user:` / `--user` means the operator has already pinned
# the runtime identity.  We cannot chown anything without CAP_CHOWN anyway, and
# gosu needs CAP_SETUID/CAP_SETGID we do not have, so hand off directly.
if [ "$(id -u)" -ne 0 ]; then
    echo "[docker-entrypoint] already running non-root — skipping heal, exec direct"
    exec openhuman-core "$@"
fi

# Make DIR and every entry under it owned by the openhuman user.
heal_dir() {
    _dir="$1"

    if ! mkdir -p "${_dir}" 2>/dev/null; then
        echo "[docker-entrypoint] WARN mkdir -p ${_dir} failed (read-only filesystem?)"
    fi

    # Numeric owner/mode of the dir and of config.toml, before any repair.
    # These three numbers are what turn a bare "Permission denied" into a
    # diagnosis, and they are the first thing to ask a reporter for.
    ls -ldn "${_dir}" 2>/dev/null | sed 's/^/[docker-entrypoint] pre-heal /' || true
    if [ -e "${_dir}/config.toml" ]; then
        ls -ln "${_dir}/config.toml" 2>/dev/null \
            | sed 's/^/[docker-entrypoint] pre-heal /' || true
    fi

    # Only touch entries that are actually mis-owned: on a healthy volume this
    # is a no-op traversal, and it avoids rewriting ctime on every file in a
    # large workspace (memory DBs, caches) at each container start.
    #
    # `-h` (lchown) is load-bearing, not a nicety.  Plain `chown` DEREFERENCES
    # symlinks, and this runs as root over a directory the (unprivileged) core
    # can write: a symlink planted at `${_dir}/x -> /etc/shadow` would otherwise
    # hand uid 10001 ownership of the target on the next container start.
    # `find` itself does not follow symlinks (-P is the default), so `-h`
    # closes the last dereference.  Hardlinks are not a path here: the workspace
    # volume is its own filesystem, and hardlinks cannot cross devices.
    if find "${_dir}" ! -user "${OPENHUMAN_USER}" -exec \
        chown -h "${OPENHUMAN_USER}:${OPENHUMAN_USER}" {} + 2>/dev/null; then
        echo "[docker-entrypoint] heal ${_dir} -> ${OPENHUMAN_USER}:${OPENHUMAN_USER} done"
    else
        echo "[docker-entrypoint] WARN chown under ${_dir} failed — no CAP_CHOWN? (cap_drop: ALL)"
        echo "[docker-entrypoint] WARN files not owned by uid=${OPENHUMAN_UID} will be unreadable"
    fi
}

heal_dir "${WORKSPACE_DIR}"

# If WORKSPACE_DIR and HOME_OPENHUMAN_DIR differ, heal the home dir too
# (core.token always lands in $HOME/.openhuman regardless of OPENHUMAN_WORKSPACE).
if [ "${WORKSPACE_DIR}" != "${HOME_OPENHUMAN_DIR}" ]; then
    heal_dir "${HOME_OPENHUMAN_DIR}"
fi

# Preflight 1: prove gosu can actually drop privileges before we blame the
# workspace for anything.  Without CAP_SETUID/CAP_SETGID (e.g. `cap_drop: ALL`
# with no matching `cap_add`) every gosu call fails, and attributing that to
# file ownership would send the operator chasing the wrong `chown`.
if ! gosu "${OPENHUMAN_USER}" true 2>/dev/null; then
    echo "[docker-entrypoint] FATAL cannot drop privileges to ${OPENHUMAN_USER} via gosu" >&2
    echo "[docker-entrypoint] FATAL the container needs CAP_SETUID + CAP_SETGID (and CAP_CHOWN to heal a root-owned volume)" >&2
    echo "[docker-entrypoint] FATAL with 'cap_drop: ALL', add: cap_add: [CHOWN, SETUID, SETGID] — or pin 'user: \"${OPENHUMAN_UID}:${OPENHUMAN_GID}\"'" >&2
    exit 1
fi

# Preflight 2: refuse to boot a container that would answer /health with 200
# while every config-dependent RPC returns EACCES.  A restart loop carrying a
# one-line remedy in `docker logs` is far easier to diagnose than a green
# container whose sign-in screen dead-ends on an os-error-13 string.
if [ -e "${WORKSPACE_DIR}/config.toml" ] \
    && ! gosu "${OPENHUMAN_USER}" test -r "${WORKSPACE_DIR}/config.toml"; then
    echo "[docker-entrypoint] FATAL ${WORKSPACE_DIR}/config.toml is not readable by ${OPENHUMAN_USER} (uid=${OPENHUMAN_UID})" >&2
    ls -ln "${WORKSPACE_DIR}/config.toml" >&2 || true
    echo "[docker-entrypoint] FATAL remedy: docker exec -u 0 <container> chown -Rh ${OPENHUMAN_UID}:${OPENHUMAN_GID} ${WORKSPACE_DIR}" >&2
    exit 1
fi

echo "[docker-entrypoint] dropping privileges -> exec gosu ${OPENHUMAN_USER} openhuman-core"
exec gosu "${OPENHUMAN_USER}" openhuman-core "$@"
