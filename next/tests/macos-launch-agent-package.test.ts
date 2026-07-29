import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LABORER_LAUNCH_AGENT_LABEL,
  laborerLaunchAgentPlist,
  macosPackageLayout,
} from "../src/companion/macos-package.ts";

const FORBIDDEN_LAUNCH_AGENT_CONTENT = /SLACK|TOKEN|SECRET|PASSWORD|\.env/i;

describe("macOS LaunchAgent package contract", () => {
  it("launches the bundled daemon independently under launchd", () => {
    const plist = laborerLaunchAgentPlist();

    expect(plist).toContain(`<string>${LABORER_LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain("<key>BundleProgram</key>");
    expect(plist).toContain(
      `<string>${macosPackageLayout.daemonBundleProgram}</string>`
    );
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).not.toMatch(FORBIDDEN_LAUNCH_AGENT_CONTENT);
    expect(plist).not.toContain("ProgramArguments");
  });

  it("uses the locations required by Service Management", () => {
    expect(macosPackageLayout.launchAgentPlist).toBe(
      `Contents/Library/LaunchAgents/${LABORER_LAUNCH_AGENT_LABEL}.plist`
    );
    expect(macosPackageLayout.serviceManager).toBe(
      "Contents/Resources/service-management"
    );
    expect(macosPackageLayout.nodeRuntime).toBe(
      "Contents/Resources/daemon/bin/node"
    );
  });

  it("maps authorization denial with the SMAppService error code", async () => {
    const helperSource = await readFile(
      resolve(
        import.meta.dirname,
        "../src/companion/native/service-management.swift"
      ),
      "utf8"
    );

    expect(helperSource).toContain("authorizationFailureErrorCode = 5");
    expect(helperSource).not.toContain("Int(kSMErrorAuthorizationFailure)");
  });
});
