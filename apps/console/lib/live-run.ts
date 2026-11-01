import type { LiveCommandAction, LiveRunState } from "@/lib/domain";

const transitions: Record<LiveRunState, Partial<Record<LiveCommandAction, LiveRunState>>> = {
  DRAFT: {},
  REVIEW: {},
  APPROVED: {},
  PREFLIGHT: {},
  ARMED: { START: "LIVE" },
  LIVE: { PAUSE: "DEGRADED", HANDOFF: "DEGRADED", END: "ENDED" },
  DEGRADED: { RECOVER: "LIVE", END: "ENDED" },
  ENDED: {},
  ARCHIVED: {}
};

export function canTransition(state: LiveRunState, action: LiveCommandAction) {
  return transitions[state][action] !== undefined;
}

export function nextStateFor(state: LiveRunState, action: LiveCommandAction): LiveRunState {
  const nextState = transitions[state][action];
  if (!nextState) throw new Error(`Action ${action} is not allowed from ${state}`);
  return nextState;
}
