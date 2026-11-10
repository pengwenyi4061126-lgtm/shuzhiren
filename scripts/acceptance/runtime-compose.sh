#!/usr/bin/env bash
set -euo pipefail

# Shared read-only helpers for Linux runtime acceptance scripts.  The helpers
# resolve the Compose project from the running deployment instead of guessing
# a container name, so a project name chosen by the operator remains valid.

runtime_acceptance_init_compose() {
  local root="${RUNTIME_REPO_ROOT:-$PWD}"
  local compose_file="${RUNTIME_COMPOSE_FILE:-$root/infra/compose/docker-compose.runtime.yml}"
  RUNTIME_ACCEPTANCE_COMPOSE_ARGS=(--project-directory "$root")
  if [[ -n "${RUNTIME_COMPOSE_PROJECT:-}" ]]; then
    RUNTIME_ACCEPTANCE_COMPOSE_ARGS+=(--project-name "$RUNTIME_COMPOSE_PROJECT")
  fi
  RUNTIME_ACCEPTANCE_COMPOSE_ARGS+=(-f "$compose_file")

  if [[ -n "${RUNTIME_COMPOSE_ENV_FILES:-}" ]]; then
    local -a env_files=()
    IFS=: read -r -a env_files <<< "$RUNTIME_COMPOSE_ENV_FILES"
    local env_file
    for env_file in "${env_files[@]}"; do
      [[ -n "$env_file" ]] || { printf 'ERROR  RUNTIME_COMPOSE_ENV_FILES contains an empty path\n' >&2; return 1; }
      [[ -f "$env_file" ]] || { printf 'ERROR  Compose env file does not exist: %s\n' "$env_file" >&2; return 1; }
      RUNTIME_ACCEPTANCE_COMPOSE_ARGS+=(--env-file "$env_file")
    done
  fi
}

runtime_acceptance_compose() {
  docker compose "${RUNTIME_ACCEPTANCE_COMPOSE_ARGS[@]}" "$@"
}

runtime_acceptance_container() {
  local service="$1"
  local -a ids=()
  mapfile -t ids < <(runtime_acceptance_compose ps -q "$service" 2>/dev/null || true)
  if (( ${#ids[@]} != 1 )) || [[ -z "${ids[0]:-}" ]]; then
    printf 'ERROR  expected exactly one Compose container for service %s; found %s\n' "$service" "${#ids[@]}" >&2
    return 1
  fi
  local running
  running="$(docker inspect -f '{{.State.Running}}' "${ids[0]}")"
  [[ "$running" == "true" ]] || { printf 'ERROR  Compose service %s is not running\n' "$service" >&2; return 1; }
  printf '%s\n' "${ids[0]}"
}

runtime_acceptance_optional_container() {
  local service="$1"
  local -a ids=()
  mapfile -t ids < <(runtime_acceptance_compose ps -q "$service" 2>/dev/null || true)
  if (( ${#ids[@]} != 1 )) || [[ -z "${ids[0]:-}" ]]; then
    return 1
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "${ids[0]}")" == "true" ]] || return 1
  printf '%s\n' "${ids[0]}"
}

runtime_acceptance_project() {
  local gateway_container="$1"
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$gateway_container"
}

runtime_acceptance_network() {
  local compose_network="$1"
  local project="$2"
  local -a networks=()
  mapfile -t networks < <(docker network ls \
    --filter "label=com.docker.compose.network=${compose_network}" \
    --filter "label=com.docker.compose.project=${project}" \
    --format '{{.Name}}')
  if (( ${#networks[@]} != 1 )) || [[ -z "${networks[0]:-}" ]]; then
    printf 'ERROR  expected exactly one Compose network %s for project %s; found %s\n' "$compose_network" "$project" "${#networks[@]}" >&2
    return 1
  fi
  printf '%s\n' "${networks[0]}"
}

runtime_acceptance_has_network() {
  local container="$1"
  local network="$2"
  docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container" | grep -Fx -- "$network" >/dev/null
}
