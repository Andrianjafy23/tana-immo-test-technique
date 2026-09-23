import { test } from "node:test";
import assert from "node:assert/strict";
import { createCrmClient, CrmClientError, type Lead } from "../crm/crm-client";

const sampleLead: Lead = {
  listingId: "listing-1",
  name: "Rina",
  phone: "0341234567",
  email: "rina@example.com",
  message: "Intéressée par cette annonce",
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("429 puis succès : retry en respectant Retry-After, une seule création finale", async () => {
  let callCount = 0;
  const calls: RequestInit[] = [];

  const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
    callCount++;
    calls.push(init!);
    if (callCount === 1) {
      return jsonResponse(
        429,
        { error: "rate limited" },
        { "Retry-After": "0" },
      );
    }
    return jsonResponse(201, {
      id: "lead-123",
      createdAt: "2026-09-22T10:00:00Z",
    });
  };

  const client = createCrmClient({
    token: "secret-token",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retryBaseDelayMs: 1,
  });

  const result = await client.createLead(sampleLead);

  assert.equal(callCount, 2);
  assert.deepEqual(result, {
    id: "lead-123",
    createdAt: "2026-09-22T10:00:00Z",
  });

  const idempotencyKeys = calls.map(
    (c) => (c.headers as Record<string, string>)["Idempotency-Key"],
  );
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);

  const authHeader = (calls[0].headers as Record<string, string>)[
    "Authorization"
  ];
  assert.equal(authHeader, "Bearer secret-token");
});

test("500 trois fois puis abandon : pas de succès, erreur retryable propagée", async () => {
  let callCount = 0;

  const fetchImpl = async () => {
    callCount++;
    return jsonResponse(500, { error: "internal error" });
  };

  const client = createCrmClient({
    token: "secret-token",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxAttempts: 3,
    retryBaseDelayMs: 1,
  });

  await assert.rejects(
    () => client.createLead(sampleLead),
    (err: unknown) => {
      assert.ok(err instanceof CrmClientError);
      assert.equal(err.status, 500);
      assert.equal(err.retryable, true);
      assert.ok(!err.message.includes("secret-token"));
      return true;
    },
  );

  assert.equal(callCount, 3);
});

test("400 : pas de réessai, échec immédiat", async () => {
  let callCount = 0;

  const fetchImpl = async () => {
    callCount++;
    return jsonResponse(400, { error: "invalid payload" });
  };

  const client = createCrmClient({
    token: "secret-token",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxAttempts: 5,
    retryBaseDelayMs: 1,
  });

  await assert.rejects(
    () => client.createLead(sampleLead),
    (err: unknown) => {
      assert.ok(err instanceof CrmClientError);
      assert.equal(err.retryable, false);
      return true;
    },
  );

  assert.equal(callCount, 1);
});
