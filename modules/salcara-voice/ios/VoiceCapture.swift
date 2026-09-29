import AVFoundation
import Foundation

/** Maps RMS to a 0…1 level that feels natural for animation (−55 dBFS … −10 dBFS). Same curve as Android. */
func salcaraLevelFromRms(_ rms: Double) -> Double {
  let db = 20.0 * log10(rms + 1e-7)
  return min(1.0, max(0.0, (db + 55.0) / 45.0))
}

/** RMS of little-endian PCM16 bytes (byte-wise reads: no alignment assumptions about the Data). */
func salcaraRms(_ pcm: Data) -> Double {
  let count = pcm.count / 2
  if count == 0 { return 0 }
  var sum = 0.0
  pcm.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    for index in 0..<count {
      let value = Int16(bitPattern: UInt16(raw[2 * index]) | (UInt16(raw[2 * index + 1]) << 8))
      let sample = Double(value) / 32768.0
      sum += sample * sample
    }
  }
  return (sum / Double(count)).squareRoot()
}

struct VoiceError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/** Plain copy of the JS capture options (CaptureOptions record), safe to pass between queues. */
struct CaptureConfig {
  var sampleRate: Int
  var chunkMs: Int
  var emitPcm: Bool
  var turnDetection: Bool
  var endSilenceMs: Int
  var utteranceWav: Bool
  var sessionWav: Bool
  var conversation: Bool
}

/**
 * Energy-based turn detection with an adaptive noise floor (port of the Android
 * TurnDetector). While the assistant is talking the threshold is raised, so its
 * own voice (after echo cancellation) does not count as the user interrupting.
 */
final class TurnDetector {
  private let endSilenceMs: Int
  private var noiseFloor = 0.004
  private var speechMs = 0
  private var silenceMs = 0
  private(set) var speaking = false

  init(endSilenceMs: Int) { self.endSilenceMs = endSilenceMs }

  /** true when speech starts, false when it ends, nil otherwise. */
  func process(rms: Double, durationMs: Int, strict: Bool) -> Bool? {
    let boost = strict ? 2.6 : 1.0
    if !speaking {
      let start = max(noiseFloor * 3.0, 0.012) * boost
      if rms > start {
        speechMs += durationMs
        if speechMs >= 200 { speaking = true; silenceMs = 0; return true }
      } else {
        speechMs = 0
        noiseFloor = noiseFloor * 0.95 + rms * 0.05
      }
    } else {
      let keep = max(noiseFloor * 2.0, 0.008) * boost
      if rms < keep {
        silenceMs += durationMs
        if silenceMs >= endSilenceMs { speaking = false; speechMs = 0; return false }
      } else {
        silenceMs = 0
      }
    }
    return nil
  }
}

/** Minimal 16-bit mono WAV writer; the header is patched on close. */
final class WavWriter {
  let url: URL
  private let sampleRate: Int
  private let handle: FileHandle
  private(set) var dataBytes = 0
  private var closed = false

  init(url: URL, sampleRate: Int) throws {
    self.url = url
    self.sampleRate = sampleRate
    guard FileManager.default.createFile(atPath: url.path, contents: Data(count: 44), attributes: nil) else {
      throw VoiceError("无法创建录音文件")
    }
    handle = try FileHandle(forWritingTo: url)
    _ = try handle.seekToEnd()
  }

  func write(_ data: Data) {
    if closed || data.isEmpty { return }
    do {
      try handle.write(contentsOf: data)
      dataBytes += data.count
    } catch {
      // Disk full or file removed: keep what was written.
    }
  }

  func durationMs() -> Int { dataBytes * 1000 / (sampleRate * 2) }

  @discardableResult
  func close() -> Int {
    if closed { return dataBytes }
    closed = true
    var header = Data()
    func ascii(_ text: String) { header.append(contentsOf: Array(text.utf8)) }
    func u32(_ value: UInt32) { var little = value.littleEndian; withUnsafeBytes(of: &little) { header.append(contentsOf: $0) } }
    func u16(_ value: UInt16) { var little = value.littleEndian; withUnsafeBytes(of: &little) { header.append(contentsOf: $0) } }
    ascii("RIFF"); u32(UInt32(36 + dataBytes)); ascii("WAVE"); ascii("fmt ")
    u32(16); u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
    ascii("data"); u32(UInt32(dataBytes))
    do {
      try handle.seek(toOffset: 0)
      try handle.write(contentsOf: header)
    } catch { /* header stays zeroed; the file is rejected downstream */ }
    try? handle.close()
    return dataBytes
  }

  func delete() {
    close()
    try? FileManager.default.removeItem(at: url)
  }
}

enum VoiceFiles {
  private static var counter = 0
  private static let lock = NSLock()

  static var directory: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("salcara-voice", isDirectory: true)
  }

  static func newFile(_ prefix: String) -> URL {
    lock.lock()
    counter += 1
    let serial = counter
    lock.unlock()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)
    let stamp = Int64(Date().timeIntervalSince1970 * 1000)
    return directory.appendingPathComponent("\(prefix)-\(stamp)-\(serial).wav", isDirectory: false)
  }
}

/** Converts the microphone's native format (often 48 kHz float, maybe stereo) to PCM16 mono at the requested rate. */
final class PcmConverter {
  private let converter: AVAudioConverter
  private let output: AVAudioFormat

  init?(from input: AVAudioFormat, sampleRate: Int) {
    guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(sampleRate), channels: 1, interleaved: true),
          let converter = AVAudioConverter(from: input, to: output) else { return nil }
    converter.downmix = true
    self.converter = converter
    self.output = output
  }

  /** Called on the tap thread only. */
  func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
    if buffer.frameLength == 0 || buffer.format.sampleRate <= 0 { return nil }
    let ratio = output.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
    guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: converted, error: &error) { _, inputStatus in
      if supplied {
        // More input will come with the next tap buffer; keep the resampler's state.
        inputStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error || converted.frameLength == 0 { return nil }
    guard let channels = converted.int16ChannelData else { return nil }
    return Data(bytes: channels[0], count: Int(converted.frameLength) * 2)
  }
}

typealias VoiceEmit = (String, [String: Any?]) -> Void

/**
 * Everything that happens to captured audio after conversion, on its own serial
 * queue: fixed-size chunks, level meter, PCM streaming, whole-session WAV, turn
 * detection and per-utterance WAV files. Mirrors the Android capture loop.
 */
final class CaptureProcessor {
  let config: CaptureConfig
  private let emit: VoiceEmit
  private let isPlaying: () -> Bool
  private let turns: TurnDetector
  private let chunkBytes: Int
  private var pending = Data()
  private var sessionWav: WavWriter?
  private var utteranceWav: WavWriter?
  private var preRoll: [Data] = []
  private var preRollBytes = 0
  private var closed = false
  /** Only touched on the processing queue. */
  var muted = false

  init(config: CaptureConfig, emit: @escaping VoiceEmit, isPlaying: @escaping () -> Bool) throws {
    self.config = config
    self.emit = emit
    self.isPlaying = isPlaying
    self.turns = TurnDetector(endSilenceMs: config.endSilenceMs)
    let samples = max(160, config.sampleRate * max(10, config.chunkMs) / 1000)
    self.chunkBytes = samples * 2
    if config.sessionWav {
      sessionWav = try WavWriter(url: VoiceFiles.newFile("dictation"), sampleRate: config.sampleRate)
    }
  }

  func accept(_ data: Data) {
    if closed { return }
    pending.append(data)
    while pending.count >= chunkBytes {
      let chunk = Data(pending.prefix(chunkBytes))
      pending.removeFirst(chunkBytes)
      process(chunk)
    }
  }

  private func process(_ chunk: Data) {
    let pcm = muted ? Data(count: chunk.count) : chunk
    let rms = salcaraRms(pcm)
    emit("onLevel", ["level": salcaraLevelFromRms(rms)])
    if config.emitPcm { emit("onPcm", ["data": pcm.base64EncodedString()]) }
    sessionWav?.write(pcm)
    if config.turnDetection {
      handleTurns(rms: rms, durationMs: (pcm.count / 2) * 1000 / config.sampleRate, pcm: pcm)
    }
  }

  private func handleTurns(rms: Double, durationMs: Int, pcm: Data) {
    switch turns.process(rms: rms, durationMs: durationMs, strict: isPlaying()) {
    case .some(true):
      emit("onSpeech", ["speaking": true])
      if config.utteranceWav, let writer = try? WavWriter(url: VoiceFiles.newFile("utterance"), sampleRate: config.sampleRate) {
        preRoll.forEach { writer.write($0) }
        utteranceWav = writer
      }
      preRoll.removeAll()
      preRollBytes = 0
    case .some(false):
      emit("onSpeech", ["speaking": false])
      if let writer = utteranceWav {
        writer.write(pcm)
        let duration = writer.durationMs()
        writer.close()
        utteranceWav = nil
        if duration >= 350 {
          emit("onUtterance", ["uri": writer.url.absoluteString, "durationMs": Double(duration)])
        } else {
          writer.delete()
        }
      }
      return
    case .none:
      break
    }
    if let writer = utteranceWav {
      writer.write(pcm)
    } else {
      preRoll.append(pcm)
      preRollBytes += pcm.count
      let limit = config.sampleRate * 2 * 4 / 10
      while preRollBytes > limit && !preRoll.isEmpty { preRollBytes -= preRoll.removeFirst().count }
    }
  }

  /** Stops processing; returns the session WAV when `keep` and something was recorded (deleted otherwise). */
  func finish(keep: Bool) -> String? {
    if closed { return nil }
    closed = true
    let tail = pending.count - pending.count % 2
    if tail > 0 { sessionWav?.write(Data(pending.prefix(tail))) }
    pending.removeAll()
    utteranceWav?.delete()
    utteranceWav = nil
    guard let wav = sessionWav else { return nil }
    sessionWav = nil
    let bytes = wav.close()
    if keep && bytes > 0 { return wav.url.absoluteString }
    wav.delete()
    return nil
  }
}
