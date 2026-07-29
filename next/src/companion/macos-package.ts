export const LABORER_LAUNCH_AGENT_LABEL = "com.laborer.daemon";
export const LABORER_LAUNCH_AGENT_PLIST = `${LABORER_LAUNCH_AGENT_LABEL}.plist`;

export const macosPackageLayout = {
  daemonBundleProgram: "Contents/MacOS/laborer-daemon",
  launchAgentPlist: `Contents/Library/LaunchAgents/${LABORER_LAUNCH_AGENT_PLIST}`,
  nodeRuntime: "Contents/Resources/daemon/bin/node",
  serviceManager: "Contents/Resources/service-management",
} as const;

export const laborerLaunchAgentPlist =
  (): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABORER_LAUNCH_AGENT_LABEL}</string>
  <key>BundleProgram</key>
  <string>${macosPackageLayout.daemonBundleProgram}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
