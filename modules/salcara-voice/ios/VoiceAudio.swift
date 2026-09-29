import AVFoundation
import Foundation

/** One streaming PCM16 voice (24 kHz TTS / realtime audio) scheduled on an AVAudioPlayerNode. Hub-queue only. */
final class StreamPlayer {
  let sampleRate: Int
  let communication: Bool
  let node = AVAudioPlayerNode()
  let format: AVAudioFormat
  /** Bumped by stop(): completion callbacks of buffers scheduled before it are ignored. */
  var epoch = 0
  var pending = 0
  var endRequested = false
  var active = false
  /** Level of each scheduled buffer, in play order. */
  var levels: [Double] = []

  init?(sampleRate: Int, communication: Bool) {
    guard sampleRate > 0, let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: 1) else { return nil }
    self.sampleRate = sampleRate
    self.communication = communication
    self.format = format
  }

  /** Little-endian PCM16 → float buffer in the node's format, plus its level. */
  func makeBuffer(_ data: Data) -> (AVAudioPCMBuffer, Double)? {
    let frames = data.count / 2
    guard frames > 0,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
          let channel = buffer.floatChannelData?[0] else { return nil }
    var sum = 0.0
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      for index in 0..<frames {
        let value = Int16(bitPattern: UInt16(raw[2 * index]) | (UInt16(raw[2 * index + 1]) << 8))
        let sample = Float(value) / 32768
        channel[index] = sample
        sum += Double(sample * sample)
      }
    }
    buffer.frameLength = AVAudioFrameCount(frames)
    return (buffer, salcaraLevelFromRms((sum / Double(frames)).squareRoot()))
  }
}

/** A running microphone capture: the tap's converter plus the processor and its queue. */
final class CaptureRun {
  let processor: CaptureProcessor
  let processQueue = DispatchQueue(label: "top.salcara.voice.process")
  var converter: PcmConverter

  init(processor: CaptureProcessor, converter: PcmConverter) {
    self.processor = processor
    self.converter = converter
  }
}

/**
 * Microphone capture and streaming playback on ONE AVAudioEngine, so that in a
 * hands-free conversation the voice-processing I/O unit (echo cancellation,
 * noise suppression) hears the assistant's own voice as its echo reference.
 * Every engine / session change happens on `queue`.
 */
final class VoiceAudio {
  private let queue = DispatchQueue(label: "top.salcara.voice.audio")
  private var engine: AVAudioEngine?
  private var voiceProcessing = false
  private var capture: CaptureRun?
  private var player: StreamPlayer?
  private var observers: [NSObjectProtocol] = []
  private let flagLock = NSLock()
  private var playerActiveFlag = false
  /** Set once from the module (sendEvent). */
  var emit: VoiceEmit = { _, _ in }
  /** Whether the system voice is currently speaking (used for barge-in strictness). */
  var systemSpeaking: () -> Bool = { false }

  init() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: nil) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
      self?.queue.async { self?.handleInterruption(began: type == .began) }
    })
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }

  // MARK: - Shared state

  var playerActive: Bool {
    flagLock.lock(); defer { flagLock.unlock() }
    return playerActiveFlag
  }

  private func setPlayerActive(_ player: StreamPlayer, _ value: Bool) {
    player.active = value
    flagLock.lock()
    playerActiveFlag = value
    flagLock.unlock()
  }

  private func makeEngine() -> AVAudioEngine {
    if let engine = engine { return engine }
    let created = AVAudioEngine()
    observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: created, queue: nil) { [weak self] _ in
      self?.queue.async { self?.handleConfigurationChange() }
    })
    engine = created
    return created
  }

  private func configureSession(conversation: Bool) throws {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playAndRecord, mode: conversation ? .voiceChat : .default, options: [.defaultToSpeaker, .allowBluetooth])
      try session.setActive(true)
    } catch {
      throw VoiceError("无法启用麦克风：\(error.localizedDescription)")
    }
  }

  @discardableResult
  private func startEngineIfNeeded() -> Bool {
    guard let engine = engine else { return false }
    if engine.isRunning { return true }
    engine.prepare()
    do {
      try engine.start()
      return true
    } catch {
      return false
    }
  }

  /** Nothing left to do: stop the engine, drop echo cancellation and let other apps' audio resume. */
  private func settle() {
    guard capture == nil, player == nil, let engine = engine else { return }
    if engine.isRunning { engine.stop() }
    if voiceProcessing {
      try? engine.inputNode.setVoiceProcessingEnabled(false)
      voiceProcessing = false
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  // MARK: - Capture

  static func requestMicrophone(_ completion: @escaping (Bool) -> Void) {
    let session = AVAudioSession.sharedInstance()
    switch session.recordPermission {
    case .granted: completion(true)
    case .denied: completion(false)
    default: session.requestRecordPermission { granted in completion(granted) }
    }
  }

  /** Starts a capture (replacing any running one). `isCurrent` false = cancelled meanwhile → resolves false. */
  func startCapture(_ config: CaptureConfig, isCurrent: @escaping () -> Bool, completion: @escaping (Result<Bool, Error>) -> Void) {
    queue.async {
      _ = self.stopCaptureInternal(keep: false)
      if !isCurrent() {
        self.settle()
        completion(.success(false))
        return
      }
      do {
        try self.beginCapture(config)
        if !isCurrent() {
          _ = self.stopCaptureInternal(keep: false)
          completion(.success(false))
          return
        }
        completion(.success(true))
      } catch {
        self.settle()
        completion(.failure(error))
      }
    }
  }

  private func beginCapture(_ config: CaptureConfig) throws {
    guard config.sampleRate >= 8000 && config.sampleRate <= 48000 else { throw VoiceError("麦克风不支持 \(config.sampleRate)Hz 采样") }
    try configureSession(conversation: config.conversation || player?.communication == true)
    let engine = makeEngine()
    if config.conversation != voiceProcessing {
      if engine.isRunning { engine.stop() }
      do {
        try engine.inputNode.setVoiceProcessingEnabled(config.conversation)
        voiceProcessing = config.conversation
      } catch {
        // No echo cancellation on this device: capture still works, the turn detector is stricter while we talk.
        voiceProcessing = false
      }
      if let player = player { engine.connect(player.node, to: engine.mainMixerNode, format: player.format) }
    }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0, let converter = PcmConverter(from: format, sampleRate: config.sampleRate) else {
      throw VoiceError("无法打开麦克风，请检查录音权限或是否被其他应用占用")
    }
    let processor = try CaptureProcessor(config: config, emit: emit, isPlaying: { [weak self] in
      guard let self = self else { return false }
      return self.playerActive || self.systemSpeaking()
    })
    let run = CaptureRun(processor: processor, converter: converter)
    install(run, on: input, format: format)
    if !startEngineIfNeeded() {
      input.removeTap(onBus: 0)
      _ = run.processQueue.sync { run.processor.finish(keep: false) }
      throw VoiceError("无法打开麦克风，请检查录音权限或是否被其他应用占用")
    }
    capture = run
  }

  private func install(_ run: CaptureRun, on input: AVAudioInputNode, format: AVAudioFormat) {
    input.removeTap(onBus: 0)
    let frames = AVAudioFrameCount(max(1024, format.sampleRate / 10))
    let converter = run.converter
    input.installTap(onBus: 0, bufferSize: frames, format: format) { buffer, _ in
      guard let data = converter.convert(buffer) else { return }
      run.processQueue.async { run.processor.accept(data) }
    }
  }

  private func stopCaptureInternal(keep: Bool) -> String? {
    guard let run = capture else { return nil }
    capture = nil
    engine?.inputNode.removeTap(onBus: 0)
    // Everything the tap already queued is processed before the files are closed.
    return run.processQueue.sync { run.processor.finish(keep: keep) }
  }

  /** Stops the microphone and returns the session WAV (if requested). Blocks until done. */
  func stopCapture() -> String? {
    return queue.sync { () -> String? in
      let uri = self.stopCaptureInternal(keep: true)
      self.settle()
      return uri
    }
  }

  func cancelCapture() {
    queue.async {
      _ = self.stopCaptureInternal(keep: false)
      self.settle()
    }
  }

  func setMuted(_ muted: Bool) {
    queue.async {
      guard let run = self.capture else { return }
      run.processQueue.async { run.processor.muted = muted }
    }
  }

  // MARK: - Playback

  func playerStart(sampleRate: Int, communication: Bool) {
    queue.async {
      if let current = self.player, current.sampleRate == sampleRate {
        self.startEngineIfNeeded()
        return
      }
      self.releasePlayerInternal()
      guard let next = StreamPlayer(sampleRate: sampleRate, communication: communication) else { return }
      if self.capture == nil {
        let session = AVAudioSession.sharedInstance()
        if communication {
          try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        } else {
          try? session.setCategory(.playback, mode: .spokenAudio, options: [])
        }
        try? session.setActive(true)
      }
      let engine = self.makeEngine()
      engine.attach(next.node)
      engine.connect(next.node, to: engine.mainMixerNode, format: next.format)
      self.player = next
      self.startEngineIfNeeded()
    }
  }

  func playerWrite(_ data: Data) {
    queue.async {
      guard let player = self.player, let made = player.makeBuffer(data) else { return }
      let buffer = made.0
      let level = made.1
      guard self.startEngineIfNeeded() else { return }
      let epoch = player.epoch
      player.pending += 1
      player.endRequested = false
      player.levels.append(level)
      if !player.active {
        self.setPlayerActive(player, true)
      }
      if player.pending == 1 { self.emit("onPlaybackLevel", ["level": level]) }
      player.node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self, weak player] _ in
        self?.queue.async { self?.bufferPlayed(player, epoch: epoch) }
      }
      if !player.node.isPlaying { player.node.play() }
    }
  }

  private func bufferPlayed(_ player: StreamPlayer?, epoch: Int) {
    guard let player = player, player === self.player, epoch == player.epoch else { return }
    player.pending = max(0, player.pending - 1)
    if !player.levels.isEmpty { player.levels.removeFirst() }
    if let next = player.levels.first { emit("onPlaybackLevel", ["level": next]) }
    if player.pending == 0 && player.endRequested { finishPlayback(player) }
  }

  private func finishPlayback(_ player: StreamPlayer) {
    player.endRequested = false
    setPlayerActive(player, false)
    emit("onPlaybackLevel", ["level": 0.0])
    emit("onPlaybackDone", ["interrupted": false])
  }

  /** No more audio for this reply: report onPlaybackDone once everything has been heard. */
  func playerEnd() {
    queue.async {
      guard let player = self.player else { return }
      player.endRequested = true
      if player.pending == 0 && player.active { self.finishPlayback(player) }
    }
  }

  /** Drops everything queued (the user interrupted). */
  func playerStop() {
    queue.async {
      guard let player = self.player else { return }
      self.flush(player)
      let wasActive = player.active
      self.setPlayerActive(player, false)
      if wasActive {
        self.emit("onPlaybackLevel", ["level": 0.0])
        self.emit("onPlaybackDone", ["interrupted": true])
      }
    }
  }

  private func flush(_ player: StreamPlayer) {
    player.epoch += 1
    player.node.stop()
    player.pending = 0
    player.levels.removeAll()
    player.endRequested = false
  }

  func playerRelease() {
    queue.async {
      self.releasePlayerInternal()
      self.settle()
    }
  }

  private func releasePlayerInternal() {
    guard let current = player else { return }
    flush(current)
    setPlayerActive(current, false)
    engine?.detach(current.node)
    player = nil
  }

  /** Conversation over: release whatever is left and leave voice-chat mode. */
  func endConversationAudio() {
    queue.async { self.settle() }
  }

  func shutdown() {
    queue.sync { () -> Void in
      _ = self.stopCaptureInternal(keep: false)
      self.releasePlayerInternal()
      self.settle()
    }
  }

  // MARK: - System events

  /** The route or hardware format changed (headphones, Bluetooth…): the engine stopped; rebuild what is running. */
  private func handleConfigurationChange() {
    guard let engine = engine, capture != nil || player != nil else { return }
    if let player = player {
      let wasActive = player.active
      flush(player)
      setPlayerActive(player, false)
      engine.connect(player.node, to: engine.mainMixerNode, format: player.format)
      // Audio still queued is lost; let the conversation move on instead of waiting for it.
      if wasActive {
        emit("onPlaybackLevel", ["level": 0.0])
        emit("onPlaybackDone", ["interrupted": false])
      }
    }
    if let run = capture {
      let input = engine.inputNode
      input.removeTap(onBus: 0)
      let format = input.outputFormat(forBus: 0)
      if format.sampleRate > 0, format.channelCount > 0, let converter = PcmConverter(from: format, sampleRate: run.processor.config.sampleRate) {
        run.converter = converter
        install(run, on: input, format: format)
      } else {
        emit("onCaptureError", ["message": "音频设备发生变化，麦克风已停止"])
      }
    }
    if !startEngineIfNeeded() && capture != nil {
      emit("onCaptureError", ["message": "音频设备发生变化，麦克风已停止"])
    }
  }

  private func handleInterruption(began: Bool) {
    if began {
      if capture != nil { emit("onCaptureError", ["message": "录音被来电或其他应用打断了，请重新开始"]) }
      if let player = player, player.active {
        flush(player)
        setPlayerActive(player, false)
        emit("onPlaybackLevel", ["level": 0.0])
        emit("onPlaybackDone", ["interrupted": false])
      }
      return
    }
    if capture != nil || player != nil {
      try? AVAudioSession.sharedInstance().setActive(true)
      startEngineIfNeeded()
    }
  }
}
