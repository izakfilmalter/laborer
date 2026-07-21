import { createInterface } from "node:readline";

interface Envelope {
  readonly turnId: string;
}

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

for await (const source of lines) {
  const envelope = JSON.parse(source) as Envelope;
  if (process.env.THREAD_PROCESS_MODE === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        replyId: `initializer:${envelope.turnId}`,
        text: "Preparing the thread workspace.",
        type: "public_reply",
      })}\n`
    );
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        type: "initialized",
        workingDirectory: process.env.THREAD_WORKING_DIRECTORY,
      })}\n`
    );
  } else {
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        replyId: `handler:${envelope.turnId}`,
        text: `Handler cwd: ${process.cwd()}`,
        type: "public_reply",
      })}\n`
    );
  }
}
