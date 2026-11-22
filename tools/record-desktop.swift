// A real recording of the macOS desktop, with only what you choose to show in it. macOS only (15 or later), and it needs the
// Screen Recording permission of whatever started it. It changes no setting and moves, hides or closes nothing on the screen.
//
//   swiftc -O tools/record-desktop.swift -o record-desktop
//   record-desktop list                                      the apps that have windows on screen, with their bundle ids
//   record-desktop record out.mov 30 --show com.apple.dock …  record the main display (or --display <id>, at --scale 2 for a sharper capture) for 30 s;
//                                                              it prints "started <ms since 1970>" the moment the first frame is taken, and the
//                                                              30 s is the most it records: a line saying "stop" on its standard input ends it sooner
//   record-desktop glide 400 300 900                         glide the pointer to a point (global coordinates), taking 900 ms
//   record-desktop where                                     print the pointer's position
//
// What it leaves out of a recording is every application that is not named with --show (the window server, which draws the wallpaper's base and the pointer, is never left out, and neither is anything but its recording indicator): its windows, its menu-bar icons and its
// notification banners are not drawn into the video, whatever is in front of what on the real screen. The Finder is not named,
// so the files and folders on the desktop are not in it either, and the wallpaper (which another application draws) is. The
// pointer is the real pointer. Nothing is sent anywhere: the output is a file.

import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)
let args = Array(CommandLine.arguments.dropFirst())

func fail(_ message: String) -> Never {
    fputs("record-desktop: \(message)\n", stderr)
    exit(1)
}

/// The pointer's position now, in the global coordinates the pointer is moved in (points, origin at the top left of the main display).
func pointer() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

/// Glide the pointer to (x, y) over `ms` milliseconds, easing in and out, the way a hand moves it.
func glide(to target: CGPoint, ms: Double) {
    let start = pointer()
    let steps = max(2, Int(ms / 8))                       // about 120 moves a second
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        let p = CGPoint(x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e)
        CGWarpMouseCursorPosition(p)
        usleep(UInt32(ms / Double(steps) * 1000))
    }
    CGWarpMouseCursorPosition(target)
}

final class StopFlag { var requested = false }

final class Finish: NSObject, SCRecordingOutputDelegate, SCStreamDelegate {
    var finished = false
    var failure: String?
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) { finished = true }
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) { failure = "\(error)"; finished = true }
    func stream(_ stream: SCStream, didStopWithError error: Error) { failure = "the stream stopped: \(error)"; finished = true }
}

func run() async {
    guard let command = args.first else { fail("usage: record-desktop list | record <out.mov> <seconds> [--show <bundle id>]… | glide <x> <y> <ms> | where") }

    switch command {
    case "where":
        let p = pointer()
        print("\(Int(p.x)) \(Int(p.y))")

    case "glide":
        guard args.count >= 4, let x = Double(args[1]), let y = Double(args[2]), let ms = Double(args[3]) else { fail("glide <x> <y> <ms>") }
        glide(to: CGPoint(x: x, y: y), ms: ms)

    case "list":
        guard CGPreflightScreenCaptureAccess() else { fail("this process has no Screen Recording permission") }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            for d in content.displays { print("display \(d.displayID): \(d.width) x \(d.height) points at \(Int(d.frame.minX)),\(Int(d.frame.minY))\(d.displayID == CGMainDisplayID() ? ", the main display" : "")") }
            if args.contains("--windows") {      // every window, without its title: who owns it, what level it is on, how big, and whether it is shown
                for w in content.windows.sorted(by: { $0.windowLayer < $1.windowLayer }) {
                    print("  window \(w.windowID) layer \(w.windowLayer) \(Int(w.frame.width))x\(Int(w.frame.height)) at \(Int(w.frame.minX)),\(Int(w.frame.minY)) \(w.isOnScreen ? "on screen" : "off screen") owner \(w.owningApplication?.bundleIdentifier ?? "(none)")\(w.windowLayer < -1_000_000_000 ? " title \"\(w.title ?? "")\"" : "")")
                }
            }
            var byApp: [String: [SCWindow]] = [:]
            for w in content.windows { byApp[w.owningApplication?.bundleIdentifier ?? "(none)", default: []].append(w) }
            for (id, windows) in byApp.sorted(by: { $0.key < $1.key }) {
                let layers = Array(Set(windows.map { $0.windowLayer })).sorted()
                print("  \(id): \(windows.count) window(s) on screen, layers \(layers)")
            }
        } catch { fail("\(error)") }

    case "record":
        guard args.count >= 3, let seconds = Double(args[2]) else { fail("record <out.mov> <seconds> [--show <bundle id>]…") }
        guard CGPreflightScreenCaptureAccess() else { fail("this process has no Screen Recording permission") }
        var shown = Set<String>()
        var wanted: UInt32? = nil
        var pixelScale = 1
        var i = 3
        while i < args.count {
            if args[i] == "--show", i + 1 < args.count { shown.insert(args[i + 1]); i += 2 }
            else if args[i] == "--display", i + 1 < args.count { wanted = UInt32(args[i + 1]); i += 2 }
            else if args[i] == "--scale", i + 1 < args.count { pixelScale = max(1, Int(args[i + 1]) ?? 1); i += 2 }
            else { i += 1 }
        }
        let url = URL(fileURLWithPath: args[1])
        try? FileManager.default.removeItem(at: url)
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == (wanted ?? CGMainDisplayID()) }) ?? content.displays.first else { fail("no display") }
            // the applications whose windows are drawn: those named, and the window server (which draws the wallpaper's base and the pointer)
            let drawn = content.applications.filter { $0.bundleIdentifier.isEmpty || shown.contains($0.bundleIdentifier) }
            let filter = SCContentFilter(display: display, including: drawn, exceptingWindows: [])
            filter.includeMenuBar = true                                // a filter that names applications leaves the menu bar out unless asked
            let config = SCStreamConfiguration()
            config.width = display.width * pixelScale
            config.height = display.height * pixelScale
            config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = true
            config.capturesAudio = false
            config.queueDepth = 6
            let finish = Finish()
            let stream = SCStream(filter: filter, configuration: config, delegate: finish)
            let recording = SCRecordingOutputConfiguration()
            recording.outputURL = url
            recording.outputFileType = .mov
            recording.videoCodecType = .h264
            let output = SCRecordingOutput(configuration: recording, delegate: finish)
            try stream.addRecordingOutput(output)
            try await stream.startCapture()
            print("started \(Int(Date().timeIntervalSince1970 * 1000))")          // the clock time (ms since 1970) the video's first frame stands for: what a caller times its steps against
            // The recording indicator macOS draws in the menu bar is a window of the window server on the menu bar's own level, made a moment
            // after the stream starts. Wait for it to exist, then draw everything but it.
            for _ in 0..<50 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let again = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) else { continue }
                let indicator = again.windows.filter { ($0.owningApplication?.bundleIdentifier ?? "").isEmpty && $0.windowLayer == 25 }
                if !indicator.isEmpty {
                    let drawnNow = again.applications.filter { $0.bundleIdentifier.isEmpty || shown.contains($0.bundleIdentifier) }
                    let updated = SCContentFilter(display: display, including: drawnNow, exceptingWindows: indicator)
                    updated.includeMenuBar = true
                    try? await stream.updateContentFilter(updated)
                    break
                }
            }
            print("recording \(config.width) x \(config.height), \(content.applications.count - drawn.count) application(s) left out, for up to \(seconds) s")
            // `seconds` is the longest it records: a line that says "stop" on its standard input ends it sooner (a caller whose script takes
            // an unpredictable time says when it is over), and the file is closed properly either way.
            let stop = StopFlag()
            FileHandle.standardInput.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty { handle.readabilityHandler = nil; return }          // nothing is listening on the other end: that is not a stop
                if String(data: data, encoding: .utf8)?.contains("stop") == true { stop.requested = true }
            }
            let deadline = Date().addingTimeInterval(seconds)
            while Date() < deadline && !stop.requested { try await Task.sleep(nanoseconds: 50_000_000) }
            FileHandle.standardInput.readabilityHandler = nil
            try await stream.stopCapture()
            for _ in 0..<200 where !finish.finished { try await Task.sleep(nanoseconds: 100_000_000) }
            if let f = finish.failure { fail(f) }
            print("wrote \(url.path)")
        } catch { fail("\(error)") }

    default:
        fail("unknown command \(command)")
    }
    exit(0)
}

// ScreenCaptureKit puts a recording indicator in the menu bar, and AppKit wants that on the main thread of a running application:
// so this is a (windowless, Dock-less) application that does its work once it has started.
final class Starter: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) { Task { await run() } }
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let starter = Starter()
application.delegate = starter
application.run()
