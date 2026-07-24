import assert from "node:assert/strict";
import test from "node:test";
import {
  requestPlannotatorReview,
  requestPlannotatorReviewStatus,
} from "../src/integrations/plannotator.ts";

test("starts a correlated Plannotator plan review", async () => {
  const response = await requestPlannotatorReview(
    {
      on: () => () => undefined,
      emit: (_channel, data) => {
        const request = data as {
          requestId: string;
          action: string;
          respond: (value: unknown) => void;
        };
        assert.equal(request.requestId, "request-1");
        assert.equal(request.action, "plan-review");
        request.respond({
          status: "handled",
          result: { status: "pending", reviewId: "review-1" },
        });
      },
    },
    "request-1",
    "# Plan",
    "test",
    1_000,
  );
  assert.deepEqual(response, {
    status: "handled",
    result: { status: "pending", reviewId: "review-1" },
  });
});

test("queries a durable Plannotator review result", async () => {
  const response = await requestPlannotatorReviewStatus(
    {
      on: () => () => undefined,
      emit: (_channel, data) => {
        const request = data as {
          action: string;
          payload: { reviewId: string };
          respond: (value: unknown) => void;
        };
        assert.equal(request.action, "review-status");
        assert.equal(request.payload.reviewId, "review-1");
        request.respond({
          status: "handled",
          result: {
            status: "completed",
            reviewId: "review-1",
            approved: true,
            feedback: "Looks good",
          },
        });
      },
    },
    "request-2",
    "review-1",
    1_000,
  );
  assert.equal(response.status, "handled");
  assert.deepEqual(
    response.status === "handled" ? response.result : undefined,
    {
      status: "completed",
      reviewId: "review-1",
      approved: true,
      feedback: "Looks good",
    },
  );
});

test("rejects a status result correlated to another review", async () => {
  const response = await requestPlannotatorReviewStatus(
    {
      on: () => () => undefined,
      emit: (_channel, data) => {
        const request = data as { respond: (value: unknown) => void };
        request.respond({
          status: "handled",
          result: {
            status: "completed",
            reviewId: "review-2",
            approved: true,
            feedback: "",
          },
        });
      },
    },
    "request-3",
    "review-1",
    1_000,
  );
  assert.deepEqual(response, {
    status: "error",
    error: "Plannotator returned a result for a different review",
  });
});
