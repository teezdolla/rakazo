import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import type { SendUserMessageInput } from "./events.js";
import { sendUserMessage } from "./events.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("sendUserMessage assignments (PostgreSQL)", () => {
  const suffix = randomUUID();
  const userId = `assignment-user-${suffix}`;
  const spaceId = `assignment-space-${suffix}`;
  const botId = `assignment-bot-${suffix}`;
  const threadId = `assignment-thread-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  const input = (clientNonce: string): SendUserMessageInput => ({
    spaceId,
    threadId,
    botId,
    userId,
    clientNonce,
    blocks: [{ kind: "text", text: "Test assignment" }],
    prompt: "Test assignment",
    trigger: "follow_up",
    requireNewRun: true,
  });
  const snapshot = async () => ({
    thread: await prisma.thread.findUniqueOrThrow({ where: { id: threadId } }),
    messages: await prisma.message.count({ where: { threadId } }),
    tasks: await prisma.task.count({ where: { threadId } }),
    runs: await prisma.run.count({ where: { threadId } }),
    events: await prisma.event.count({ where: { threadId } }),
    steering: await prisma.steeringMessage.count({ where: { botId } }),
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Assignment Test", email: `${userId}@rakazo.test` },
    });
    await prisma.organization.create({
      data: { id: spaceId, name: "Assignment Test", slug: spaceId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: {
        id: spaceId,
        organizationId: spaceId,
        name: "Assignment Test",
        createdByUserId: userId,
      },
    });
    await prisma.bot.create({
      data: { id: botId, spaceId, userId, name: "Assignment Test", color: "primary" },
    });
    await prisma.thread.create({ data: { id: threadId, spaceId, botId, userId } });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: spaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await close();
    }
  });

  it("rolls back the message, nonce, and sequence while busy, then retries exactly once", async () => {
    const active = await sendUserMessage(prisma, input("active"));
    const before = await snapshot();
    await expect(sendUserMessage(prisma, input("retryable"))).rejects.toThrow(
      "ASSIGNMENT_REQUIRES_NEW_RUN",
    );
    expect(await snapshot()).toEqual(before);
    await prisma.run.update({ where: { id: active.runId! }, data: { status: "succeeded" } });
    const assigned = await sendUserMessage(prisma, input("retryable"));
    expect(assigned.taskId).toBeTruthy();
    expect(assigned.runId).not.toBe(active.runId);
    const after = await snapshot();
    expect(await sendUserMessage(prisma, input("retryable"))).toEqual(assigned);
    expect(await snapshot()).toEqual(after);
    expect(after.messages).toBe(before.messages + 1);
    expect(after.tasks).toBe(before.tasks + 1);
    expect(after.runs).toBe(before.runs + 1);
    expect(after.events).toBe(before.events + 1);
    expect(after.steering).toBe(0);
  });

  it("serializes simultaneous assignments and leaves the rejected nonce reusable", async () => {
    await prisma.run.updateMany({ where: { threadId }, data: { status: "succeeded" } });
    const before = await snapshot();
    const results = await Promise.allSettled([
      sendUserMessage(prisma, input("race-a")),
      sendUserMessage(prisma, input("race-b")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedIndex = results.findIndex((result) => result.status === "rejected");
    expect(results[rejectedIndex]).toMatchObject({
      status: "rejected",
      reason: new Error("ASSIGNMENT_REQUIRES_NEW_RUN"),
    });
    const after = await snapshot();
    expect(after.messages).toBe(before.messages + 1);
    expect(after.tasks).toBe(before.tasks + 1);
    expect(after.runs).toBe(before.runs + 1);
    expect(after.events).toBe(before.events + 1);
    expect(after.steering).toBe(0);
    await prisma.run.updateMany({ where: { threadId }, data: { status: "succeeded" } });
    await expect(
      sendUserMessage(prisma, input(rejectedIndex === 0 ? "race-a" : "race-b")),
    ).resolves.toMatchObject({ taskId: expect.any(String), runId: expect.any(String) });
  });

  it("preserves chat steering but never replays it as an owned assignment", async () => {
    const chat = await sendUserMessage(prisma, { ...input("chat"), requireNewRun: false });
    expect(chat.taskId).toBeNull();
    const before = await snapshot();
    expect(before.steering).toBe(1);
    expect(await sendUserMessage(prisma, { ...input("chat"), requireNewRun: false })).toEqual(chat);
    await expect(sendUserMessage(prisma, input("chat"))).rejects.toThrow(
      "ASSIGNMENT_NONCE_HAS_NO_OWNED_RUN",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("preserves explicit parallel delivery and replays a simultaneous identical nonce", async () => {
    const before = await snapshot();
    const parallel = { ...input("parallel"), allowParallelRun: true };
    const [first, second] = await Promise.all([
      sendUserMessage(prisma, parallel),
      sendUserMessage(prisma, parallel),
    ]);
    expect(first.taskId).toBeTruthy();
    expect(second).toEqual(first);
    const after = await snapshot();
    expect(after.messages).toBe(before.messages + 1);
    expect(after.tasks).toBe(before.tasks + 1);
    expect(after.runs).toBe(before.runs + 1);
    expect(after.events).toBe(before.events + 1);
    expect(after.steering).toBe(before.steering);
  });
});
