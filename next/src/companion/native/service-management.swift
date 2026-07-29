import Foundation
import ServiceManagement

private let protocolVersion = 1
private let serviceVersion = "__LABORER_VERSION__"
private let launchAgentPlist = "com.laborer.daemon.plist"

private enum NativeState: String {
    case denied
    case enabled
    case notFound = "not-found"
    case notRegistered = "not-registered"
    case requiresApproval = "requires-approval"
}

@available(macOS 13.0, *)
private func currentState(_ service: SMAppService) -> NativeState {
    switch service.status {
    case .enabled:
        return .enabled
    case .notFound:
        return .notFound
    case .notRegistered:
        return .notRegistered
    case .requiresApproval:
        return .requiresApproval
    @unknown default:
        return .notFound
    }
}

private func writeResponse(_ state: NativeState) {
    let value: [String: Any] = [
        "protocolVersion": protocolVersion,
        "serviceVersion": serviceVersion,
        "state": state.rawValue,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let output = String(data: data, encoding: .utf8) else {
        exit(1)
    }
    print(output)
}

@main
private struct LaborerServiceManagement {
    static func main() {
        guard #available(macOS 13.0, *) else {
            writeResponse(.notFound)
            return
        }
        let arguments = CommandLine.arguments
        guard arguments.count == 2 else {
            writeResponse(.notFound)
            return
        }
        let service = SMAppService.agent(plistName: launchAgentPlist)
        switch arguments[1] {
        case "status":
            writeResponse(currentState(service))
        case "register":
            do {
                try service.register()
                writeResponse(currentState(service))
            } catch let error as NSError {
                if error.domain == SMAppServiceErrorDomain &&
                    error.code == Int(kSMErrorAuthorizationFailure) {
                    writeResponse(.denied)
                } else {
                    let state = currentState(service)
                    writeResponse(state == .requiresApproval ? state : .notFound)
                }
            }
        case "unregister":
            do {
                try service.unregister()
                writeResponse(currentState(service))
            } catch {
                writeResponse(.notFound)
            }
        default:
            writeResponse(.notFound)
        }
    }
}
