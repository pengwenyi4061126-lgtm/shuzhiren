export type LiveRunState = "DRAFT" | "REVIEW" | "APPROVED" | "PREFLIGHT" | "ARMED" | "LIVE" | "DEGRADED" | "ENDED" | "ARCHIVED";

export type LiveCommandAction = "START" | "PAUSE" | "HANDOFF" | "END" | "RECOVER" | "INSERT_PROGRAM" | "ROLLBACK_PROGRAM";

export type LiveCommand = {
  id: string;
  action: LiveCommandAction;
  actorName: string;
  issuedAt: string;
  expectedState: LiveRunState;
  result: "accepted" | "rejected";
  programSegmentId?: string;
};

export type LiveQuestion = {
  id: string;
  text: string;
  detail: string;
  risk: "low" | "medium" | "high";
};

export type LiveRun = {
  id: string;
  showName: string;
  state: LiveRunState;
  traceId: string;
  scheduledAt?: string;
  activeProgramSegmentId?: string;
  activeInsertSourceSegmentId?: string;
  activeInsertProgramSegmentId?: string;
  pendingProgramTransitionEventId?: string;
  commandHistory: LiveCommand[];
  questions: LiveQuestion[];
};
