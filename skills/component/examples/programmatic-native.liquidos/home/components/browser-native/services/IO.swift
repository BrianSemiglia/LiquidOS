import Foundation
import AVFoundation
import Darwin

struct Truth: Codable {
    var status: String
    var permission: String?
    var inputDeviceName: String?
    var active: Bool?
    var level: Int?
    var peak: Int?
    var updatedAt: String?
    var error: String?
}

final class State {
    var peak = 0
    var lastWrite = Date.distantPast
}

final class PermissionResult {
    var granted = false
}

let state = State()
let truthURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .deletingLastPathComponent()
    .appendingPathComponent("data")
    .appendingPathComponent("truth.json")
let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return encoder
}()
let engine = AVAudioEngine()
let writeQueue = DispatchQueue(label: "local.liquidos.microphone-activity.write")

func log(_ values: Any...) {
    print(ISO8601DateFormatter().string(from: Date()), "IO:", values.map { "\($0)" }.joined(separator: " "))
    fflush(stdout)
}

func now() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func readTruth() -> Truth {
    (try? JSONDecoder().decode(Truth.self, from: Data(contentsOf: truthURL))) ?? Truth(status: "idle")
}

func writeTruth(_ truth: Truth) {
    do {
        try encoder.encode(truth).write(to: truthURL, options: .atomic)
    } catch {
        log("write truth failed", error.localizedDescription)
    }
}

func writeStatus(_ status: String, permission: String? = nil, error: String? = nil) {
    writeTruth(Truth(
        status: status,
        permission: permission ?? readTruth().permission,
        inputDeviceName: AVCaptureDevice.default(for: .audio)?.localizedName ?? "Microphone",
        active: false,
        level: 0,
        peak: 0,
        updatedAt: now(),
        error: error
    ))
}

func microphonePermission() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        writeStatus("watching", permission: "authorized")
        return true
    case .denied:
        writeStatus("permission denied", permission: "denied", error: "Microphone permission denied")
        return false
    case .restricted:
        writeStatus("permission restricted", permission: "restricted", error: "Microphone permission restricted")
        return false
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        let result = PermissionResult()

        AVCaptureDevice.requestAccess(for: .audio) { value in
            result.granted = value
            semaphore.signal()
        }

        semaphore.wait()
        writeStatus(result.granted ? "watching" : "permission denied", permission: result.granted ? "authorized" : "denied", error: result.granted ? nil : "Microphone permission denied")
        return result.granted
    @unknown default:
        writeStatus("permission unknown", permission: "unknown", error: "Unknown microphone permission state")
        return false
    }
}

func levelPercent(from buffer: AVAudioPCMBuffer) -> Int {
    guard let channelData = buffer.floatChannelData else { return 0 }

    let frames = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    let sum = (0..<channelCount).reduce(Float(0)) { channelSum, channel in
        channelSum + (0..<frames).reduce(Float(0)) { frameSum, frame in
            frameSum + channelData[channel][frame] * channelData[channel][frame]
        }
    }

    guard frames > 0 && channelCount > 0 else { return 0 }

    return Int(min(100, max(0, sqrt(sum / Float(frames * channelCount)) * 220)).rounded())
}

func startMonitoring() throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)

    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        writeQueue.async {
            guard Date().timeIntervalSince(state.lastWrite) > 0.08 else { return }

            let level = levelPercent(from: buffer)

            state.lastWrite = Date()
            state.peak = max(level, max(0, state.peak - 2))

            writeTruth(Truth(
                status: "watching",
                permission: "authorized",
                inputDeviceName: AVCaptureDevice.default(for: .audio)?.localizedName ?? "Microphone",
                active: level > 3,
                level: level,
                peak: state.peak,
                updatedAt: now(),
                error: nil
            ))
        }
    }

    engine.prepare()
    try engine.start()
    writeStatus("watching", permission: "authorized")
}

if microphonePermission() {
    do {
        try startMonitoring()
        log("watching microphone")
        RunLoop.main.run()
    } catch {
        writeStatus("error", permission: "authorized", error: error.localizedDescription)
        log("error", error.localizedDescription)
        RunLoop.main.run()
    }
} else {
    RunLoop.main.run()
}
