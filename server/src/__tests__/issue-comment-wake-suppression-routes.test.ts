import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MENTIONED_AGENT_ID = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getDependencyReadiness: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => mockIssueReferenceService,
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Wake suppression test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

// Regression coverage for the canary-containment finding recorded in
// controlled-live-canary-2026-08-13.md defect #2: "A follow-up comment
// launched work even with `resume: false`". `resume` only ever controlled
// the reopen-intent status transition, never whether the assignee was woken
// -- a comment on a non-closed, non-self-authored issue always enqueued a
// wakeup regardless of any client-supplied flag. This suite proves the new
// explicit `wake: false` comment field actually suppresses the wakeup (and
// the @-mention wakeups it would otherwise also trigger), while confirming
// omitting `wake` preserves the original always-wakes-the-assignee behavior.
describe("issue comment wake suppression", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
  });

  it("does not wake the assignee when the comment sets wake:false", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "evidence only, do not wake",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "evidence only, do not wake", wake: false });

    expect(res.status).toBe(201);
    // Give the fire-and-forget wakeup microtask a tick to run if it were
    // (incorrectly) going to fire.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    // Higher timeout: this is the first test in the file to exercise
    // vi.importActual on routes/issues.js, whose one-time module compile
    // cost is what actually consumes the wall clock here, not the request.
  }, 20000);

  it("does not wake even a resume:true follow-up when wake:false is set", async () => {
    const issue = makeIssue({ status: "blocked" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    mockIssueService.update.mockResolvedValue({ ...issue, status: "todo" });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "reopen but do not wake",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "reopen but do not wake", resume: true, wake: false });

    expect(res.status).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    // The status transition still happens (resume:true reopens the issue)...
    expect(mockIssueService.update).toHaveBeenCalledWith(issue.id, { status: "todo" });
    // ...but no wakeup is enqueued because wake:false was explicit.
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not wake @-mentioned agents when wake:false is set", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-3",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "@someone please note this only",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "@someone please note this only", wake: false });

    expect(res.status).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    // findMentionedAgents should not even be consulted when wakes are
    // suppressed -- mention resolution exists only to enqueue a wakeup.
    expect(mockIssueService.findMentionedAgents).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("still wakes the assignee by default when wake is omitted (unchanged behavior)", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-4",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "normal comment, should wake as before",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "normal comment, should wake as before" });

    expect(res.status).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
      }),
    );
  });

  it("still wakes the assignee when wake:true is explicit", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-5",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "explicit wake",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${issue.id}/comments`)
      .send({ body: "explicit wake", wake: true });

    expect(res.status).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
  });
});
