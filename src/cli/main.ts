/** Entry point and composition root: parses arguments, wires everything, and maps errors to exit codes. */
import { readFileSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { LIMITS, SHUTDOWN_TIMEOUT_MS } from "../core/constants/limits.js";
import { PROVIDER_CHOICES } from "../core/constants/llm.js";
import { ARGV_OFFSET } from "../core/constants/terminal.js";
import {
  EXIT_CODES,
  exitCodeFor,
  RESUME_HINT,
  LlmError,
  TaskDatabaseError,
  UsageError,
  ValidationFailedError,
} from "../core/errors.js";
import { runEnvironmentCommand, type EnvironmentCommandOptions } from "./environment-command.js";
import { runGenerate, type CommandContext, type GenerateOptions } from "./generate-command.js";
import { commandHelp, GUIDE_TEXT, HELP_HOW_IT_WORKS } from "./guide.js";
import { collect, integerInRange, oneOf, positiveNumber } from "./options.js";
import { runClean, runDoctor, runModelCommand, runSkillsCommand, type SkillsCommandOptions } from "./other-commands.js";
import { createReporter, type ColorMode, type Reporter } from "./reporter.js";
import { addTasksCommand } from "./tasks-command.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

function readEarlyFlags(argv: readonly string[]): {
  json: boolean;
  quiet: boolean;
  debug: boolean;
  debugFile?: string;
  color: ColorMode;
} {
  const debugFileIndex = argv.indexOf("--debug-file");
  const debugFile = debugFileIndex === -1 ? undefined : argv[debugFileIndex + 1];
  const colorIndex = argv.indexOf("--color");
  const color = colorIndex === -1 ? "auto" : argv[colorIndex + 1];
  return {
    json: argv.includes("--json"),
    quiet: argv.includes("--quiet") || argv.includes("-q"),
    debug: argv.includes("--debug") || argv.includes("-d"),
    ...(debugFile === undefined ? {} : { debugFile }),
    color: color === "always" || color === "never" ? color : "auto",
  };
}

function limitOption(
  flags: string,
  description: string,
  limit: { readonly minimum: number; readonly maximum: number; readonly default: number },
): [string, string, (value: string) => number, number] {
  return [
    flags,
    `${description} (${limit.minimum} to ${limit.maximum})`,
    integerInRange(limit.minimum, limit.maximum),
    limit.default,
  ];
}

function buildProgram(context: CommandContext, setExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name("cclinic")
    .description("Generate spec-driven development documents for a project, using Claude.")
    .version(version, "-v, --version", "show the version")
    .helpOption("-h, --help", "show help")
    // Registered explicitly, because commander leaves it out when the main command has an action.
    .helpCommand("help [command]", "show help for a command")
    // Keeps options such as --json and --yes for the subcommand they follow.
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (text) => process.stdout.write(text),
      writeErr: (text) => process.stderr.write(text),
    });

  program
    .argument("[path]", "folder to analyse (default: the current folder)")
    .optionsGroup("Output options:")
    .option("-q, --quiet", "show only errors and the final result")
    .option("-d, --debug", "show diagnostic details on stderr")
    .option("--debug-file <path>", "write diagnostic details to a file")
    .option("--json", "write the final result as JSON on stdout")
    .addOption(new Option("--color <mode>", "use color in output").choices(["auto", "always", "never"]).default("auto"))
    .optionsGroup("Generation options:")
    .option("-o, --out <dir>", "output folder (default: <path>/.cclinic/sdd)")
    .addOption(
      new Option("--provider <name>", "how to reach Claude (default: auto, or CCLINIC_PROVIDER)").argParser(
        oneOf(PROVIDER_CHOICES),
      ),
    )
    .option("-m, --model [value]", "model to use. With no value, opens a menu (default: saved default, or sonnet)")
    .option("--effort [value]", "reasoning level. With no value, opens a menu (default: saved default, or medium)")
    .addOption(
      new Option("--include <glob>", "force a path into the scan. Repeatable").argParser(collect).default([], "none"),
    )
    .addOption(
      new Option("--exclude <glob>", "force a path out of the scan. Repeatable").argParser(collect).default([], "none"),
    )
    .option("-n, --dry-run", "scan and report only, with no generation or file writes")
    .option("-f, --force", "overwrite documents that were edited by hand")
    .option("-y, --yes", "skip the confirmation prompt")
    .option("--no-cache", "re-analyse everything, ignoring cached results")
    .option("--no-skills", "don't install the agent skills")
    .option("--environment", "set up the local environment without asking")
    .option("--no-environment", "don't offer to set up the local environment")
    .option("--no-git", "don't create a repository, use Git history, or alert about a remote")
    .option("--allow-broad-target", "allow running on a home folder or filesystem root")
    .optionsGroup("Limits:")
    .option(
      "--max-files <n>",
      "stop if more files than this would be analysed",
      integerInRange(LIMITS.maxFiles.minimum, LIMITS.maxFiles.maximum),
      LIMITS.maxFiles.default,
    )
    .option(
      "--max-input-tokens <n>",
      "stop if the estimate is above this. Cached modules don't count",
      integerInRange(LIMITS.maxInputTokens.minimum, LIMITS.maxInputTokens.maximum),
      LIMITS.maxInputTokens.default,
    )
    .option(...limitOption("--max-file-size-mib <n>", "skip text files larger than this", LIMITS.maxFileSizeMib))
    .option("--max-budget-usd <n>", "aim to stop once this estimated spend is reached (default: none)", positiveNumber)
    .option(...limitOption("--concurrency <n>", "maximum simultaneous Claude calls", LIMITS.concurrency))
    .option(...limitOption("--timeout-minutes <n>", "time limit for each Claude call", LIMITS.timeoutMinutes))
    .option(...limitOption("--max-retries <n>", "retries for temporary failures", LIMITS.maxRetries))
    .addHelpText("after", HELP_HOW_IT_WORKS)
    .action(async (given: string | undefined, _options: unknown, command: Command) => {
      const options = command.opts<GenerateOptions & { quiet?: boolean; debug?: boolean }>();
      if (options.quiet === true && options.debug === true)
        throw new UsageError("--quiet and --debug can't be used together.");
      // Commander keeps only the last of a negatable pair, so the conflict is only visible in the arguments.
      if (
        process.argv.includes("--environment") &&
        (process.argv.includes("--no-environment") || process.argv.includes("--no-skills"))
      )
        throw new UsageError("--environment can't be used with --no-environment or --no-skills.");
      await runGenerate(given, options, context);
    });

  program
    .command("guide")
    .description("Show the full walkthrough: how cclinic works, and what to do at each step")
    .action(() => {
      context.reporter.result(GUIDE_TEXT.trimEnd());
    });

  program
    .command("model")
    .description("Choose, list or reset the default model and reasoning level")
    .option("--list", "print the options and the current choice")
    .option("--reset", "remove the saved default")
    .option("--json", "with --list, print JSON")
    .addHelpText("after", commandHelp("cclinic model", "cclinic model --list --json"))
    .action(async (options: { list?: boolean; reset?: boolean; json?: boolean }) => {
      await runModelCommand(options, context);
    });

  program
    .command("doctor")
    .description("Check that cclinic is ready to run, without using any Claude usage")
    .argument("[path]", "folder to check (default: the current folder)")
    .option("--json", "print JSON")
    .addHelpText("after", commandHelp("cclinic doctor", "cclinic doctor ./my-project --json"))
    .action(async (given: string | undefined, options: { json?: boolean }) => {
      setExit(await runDoctor(given, options, context));
    });

  program
    .command("skills")
    .description("Install the coding agent skills, without using any Claude usage")
    .argument("[path]", "project folder (default: the current folder)")
    .option("-o, --out <dir>", "where the project documents are (default: <path>/.cclinic/sdd)")
    .option("-f, --force", "replace cclinic skills that were edited")
    .option("--json", "print JSON")
    .addHelpText("after", commandHelp("cclinic skills", "cclinic skills ./my-project --out docs/sdd --json"))
    .action(async (given: string | undefined, options: SkillsCommandOptions) => {
      await runSkillsCommand(given, options, context);
    });

  addTasksCommand(program, context);

  program
    .command("environment")
    .description("Set up a local environment for previewing changes, using Claude")
    .argument("[path]", "project folder (default: the current folder)")
    .option("-o, --out <dir>", "where the project documents are (default: <path>/.cclinic/sdd)")
    .option("-m, --model [value]", "model to use. With no value, opens a menu")
    .option("--effort [value]", "reasoning level. With no value, opens a menu")
    .option("--max-budget-usd <n>", "stop at this estimated spend (default: 2)", positiveNumber)
    .option("-y, --yes", "skip the confirmation prompt")
    .option("-f, --force", "set up the environment again")
    .option("--allow-broad-target", "allow running on a home folder or filesystem root")
    .option("--json", "print JSON")
    .addHelpText("after", commandHelp("cclinic environment", "cclinic environment ./my-project --yes --json"))
    .action(async (given: string | undefined, options: EnvironmentCommandOptions) => {
      await runEnvironmentCommand(given, options, context);
    });

  program
    .command("clean")
    .description("Delete the cache and failed drafts. Generated documents aren't touched")
    .argument("[path]", "folder to clean (default: the current folder)")
    .option("-y, --yes", "skip the confirmation prompt")
    .addHelpText("after", commandHelp("cclinic clean", "cclinic clean ./my-project --yes"))
    .action(async (given: string | undefined, options: { yes?: boolean }) => {
      await runClean(given, options, context);
    });

  return program;
}

function reportFailure(error: unknown, code: number, isJson: boolean, reporter: Reporter): void {
  const message = error instanceof Error ? error.message : String(error);
  const problems = error instanceof ValidationFailedError ? error.problems : [];
  const hint = error instanceof LlmError && !message.includes(RESUME_HINT) ? ` ${RESUME_HINT}` : "";
  const isExpected = code !== EXIT_CODES.internal || error instanceof TaskDatabaseError;

  reporter.error(`${isExpected ? message : `Something unexpected went wrong: ${message}`}${hint}`);
  for (const problem of problems) reporter.notice(`  - ${problem}`);
  if (error instanceof Error && error.stack !== undefined) reporter.debug(error.stack);
  if (isJson) {
    reporter.result(
      JSON.stringify({
        status: "error",
        exitCode: code,
        errorType: error instanceof Error ? error.name : "Error",
        message: `${message}${hint}`,
        ...(problems.length === 0 ? {} : { problems }),
      }),
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(ARGV_OFFSET);
  const flags = readEarlyFlags(argv);
  const reporter = createReporter({
    quiet: flags.quiet,
    debug: flags.debug,
    ...(flags.debugFile === undefined ? {} : { debugFile: flags.debugFile }),
    color: flags.color,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });

  const controller = new AbortController();
  let signalCode: number | undefined;
  const onSignal = (code: number): void => {
    if (signalCode !== undefined) process.exit(code);
    signalCode = code;
    reporter.notice("Stopping... Finished work is kept. Press Ctrl+C again to exit immediately.");
    controller.abort();
    setTimeout(() => process.exit(code), SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on("SIGINT", () => {
    onSignal(EXIT_CODES.sigint);
  });
  process.on("SIGTERM", () => {
    onSignal(EXIT_CODES.sigterm);
  });

  const fail = (error: unknown): never => {
    reportFailure(error, EXIT_CODES.internal, flags.json, reporter);
    process.exit(EXIT_CODES.internal);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);

  let exitCode: number = EXIT_CODES.success;
  const context: CommandContext = { reporter, environment: process.env, signal: controller.signal, version };
  try {
    await buildProgram(context, (code) => {
      exitCode = code;
    }).parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version also arrive here, with exit code 0.
      exitCode = error.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.usage;
      if (exitCode !== EXIT_CODES.success && flags.json) {
        reporter.result(JSON.stringify({ status: "error", exitCode, errorType: "UsageError", message: error.message }));
      }
    } else {
      exitCode = signalCode ?? exitCodeFor(error);
      reportFailure(error, exitCode, flags.json, reporter);
    }
  }
  process.exitCode = signalCode ?? exitCode;
  // Ends the process once output has drained, even if a library left a handle open.
  process.stdout.write("", () => process.exit(process.exitCode));
}

await main();
