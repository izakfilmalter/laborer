/**
 * THROWAWAY PROTOTYPE: executable model of a warm blue/green daemon reload.
 *
 * Assumption: work accepted while the active generation drains may wait until
 * its in-flight work finishes. This prototype tests that state model only.
 */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { BlueGreenReloadPrototype } from "./reload-state.ts";

const COMMAND_SEPARATOR = /\s+/;

const show = (message: string, prototype: BlueGreenReloadPrototype): void => {
  console.log(`\n${message}`);
  console.log(JSON.stringify(prototype.snapshot(), null, 2));
};

const runScenario = (): void => {
  const prototype = new BlueGreenReloadPrototype();
  show("Initial state", prototype);
  show(prototype.submitWork("turn-1"), prototype);
  show(prototype.prepare("broken", false), prototype);
  show(prototype.prepare("green"), prototype);
  show(prototype.beginReload("green"), prototype);
  show(prototype.submitWork("turn-2"), prototype);
  show(prototype.completeWork("turn-1"), prototype);
  show(prototype.completeWork("turn-2"), prototype);

  const final = prototype.snapshot();
  if (
    final.activeGenerationId !== "green" ||
    final.candidateGenerationId !== null ||
    final.queuedWork.length !== 0
  ) {
    throw new Error("scripted blue/green proof failed");
  }
  console.log("\nPASS: green owns new work only after blue drained.");
};

const help = `Commands:
  work <id>                  Start work, or queue it during drain
  done <id>                  Complete in-flight work
  prepare <generation>       Prepare a candidate without runtime ownership
  prepare-fail <generation>  Demonstrate rejected candidate preparation
  reload <generation>        Drain active generation, then cut over
  state                      Print current state
  reset                      Restore the initial blue generation
  scenario                   Run the scripted proof
  help                       Print this help
  quit                       Exit`;

const runInteractive = async (): Promise<void> => {
  const prototype = new BlueGreenReloadPrototype();
  const input = createInterface({ input: stdin, output: stdout });
  console.log("THROWAWAY blue/green reload prototype");
  console.log(help);
  show("Initial state", prototype);
  while (true) {
    const line = (await input.question("\nblue-green> ")).trim();
    const [command = "", argument] = line.split(COMMAND_SEPARATOR, 2);
    if (command === "quit" || command === "exit") {
      break;
    }
    if (command === "help") {
      console.log(help);
      continue;
    }
    if (command === "scenario") {
      runScenario();
      continue;
    }
    if (command === "state" || command.length === 0) {
      show("Current state", prototype);
      continue;
    }
    if (command === "reset") {
      show(prototype.reset(), prototype);
      continue;
    }
    if (argument === undefined || argument.length === 0) {
      console.log(`${command} requires an argument`);
      continue;
    }
    switch (command) {
      case "work":
        show(prototype.submitWork(argument), prototype);
        break;
      case "done":
        show(prototype.completeWork(argument), prototype);
        break;
      case "prepare":
        show(prototype.prepare(argument), prototype);
        break;
      case "prepare-fail":
        show(prototype.prepare(argument, false), prototype);
        break;
      case "reload":
        show(prototype.beginReload(argument), prototype);
        break;
      default:
        console.log(`unknown command: ${command}`);
    }
  }
  input.close();
};

if (process.argv.includes("--scenario")) {
  runScenario();
} else {
  await runInteractive();
}
