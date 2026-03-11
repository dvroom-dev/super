type ActiveSupervisorReview = {
  controller: AbortController;
  promise: Promise<unknown>;
  threadId?: string;
};

const activeSupervisorReviews = new Map<string, ActiveSupervisorReview>();

function supervisorReviewKey(workspaceRoot: string, conversationId: string): string {
  return `${workspaceRoot}::${conversationId}`;
}

export async function claimSupervisorReviewLane(args: {
  workspaceRoot: string;
  conversationId: string;
  threadId?: string;
}) {
  const reviewKey = supervisorReviewKey(args.workspaceRoot, args.conversationId);
  const priorReview = activeSupervisorReviews.get(reviewKey);
  let threadId = args.threadId;
  if (priorReview) {
    priorReview.controller.abort();
    try {
      await priorReview.promise;
    } catch {
      // Prior review was intentionally interrupted by a newer review.
    }
    threadId = priorReview.threadId ?? threadId;
  }

  const currentReview: ActiveSupervisorReview = {
    controller: new AbortController(),
    promise: Promise.resolve(),
    threadId,
  };
  activeSupervisorReviews.set(reviewKey, currentReview);

  return {
    controller: currentReview.controller,
    threadId,
    setPromise(promise: Promise<unknown>) {
      currentReview.promise = promise;
    },
    updateThreadId(nextThreadId?: string) {
      if (nextThreadId) {
        currentReview.threadId = nextThreadId;
      }
    },
    release() {
      if (activeSupervisorReviews.get(reviewKey) === currentReview) {
        activeSupervisorReviews.delete(reviewKey);
      }
    },
  };
}
