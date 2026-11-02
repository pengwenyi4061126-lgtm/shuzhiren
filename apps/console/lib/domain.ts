export type LiveRunState = "DRAFT" | "REVIEW" | "APPROVED" | "PREFLIGHT" | "ARMED" | "LIVE" | "DEGRADED" | "ENDED" | "ARCHIVED";

export type LiveCommandAction = "START" | "PAUSE" | "HANDOFF" | "END" | "RECOVER";

export type LiveCommand = {
  id: string;
  action: LiveCommandAction;
  actorName: string;
  issuedAt: string;
  expectedState: LiveRunState;
  result: "accepted" | "rejected";
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
  commandHistory: LiveCommand[];
  questions: LiveQuestion[];
};
