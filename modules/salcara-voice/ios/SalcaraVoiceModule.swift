import ExpoModulesCore
import Foundation

/** Mirrors the Android RecognizerOptions record; iOS has no on-device recognizer, so it is ignored. */
struct RecognizerOptions: Record {
  @Field var kind: String = ""
  @Field var encoder: String = ""
  @Field var decoder: String = ""
  @Field var joiner: String = ""
  @Field var model: String = ""
  @Field var tokens: String = ""
  @Field var vad: String = ""
  @Field var numThreads: Int = 2
  @Field var endSilence: Double = 0.8
}

struct CaptureOptions: Record {
  @Field var sampleRate: Int = 16000
  @Field var chunkMs: Int = 40
  /** Stream raw PCM16 to JS (realtime voice models). */
  @Field var emitPcm: Bool = false
  /** On-device recognizer (Android only; ignored here, engineAvailable() is false). */
  @Field var useRecognizer: Bool = false
  /** Emit onSpeech start/stop from energy-based turn detection. */
  @Field var turnDetection: Bool = false
  @Field var endSilenceMs: Int = 800
  /** Write each detected utterance to a WAV file (cloud transcription in conversation). */
  @Field var utteranceWav: Bool = false
  /** Write the whole capture to a WAV file (cloud dictation). */
  @Field var sessionWav: Bool = false
  /** Hands-free conversation: echo cancellation, noise suppression, speakerphone. */
  @Field var conversation: Bool = false
}

struct StopCaptureResult: Record {
  @Field var uri: String? = nil
}

/**
 * iOS implementation of the SalcaraVoice module (same JS surface as Android):
 * AVAudioEngine microphone capture, streaming PCM playback and
 * AVSpeechSynthesizer. There is no sherpa-onnx engine on iOS, so
 * engineAvailable() is false and the JS side uses cloud recognition.
 */
public class SalcaraVoiceModule: Module {
  private let audio = VoiceAudio()
  private let speaker = SystemSpeaker()
  private let generationLock = NSLock()
  /** Bumped by every start / stop / cancel, so a start that a cancel overtook is undone. */
  private var captureGeneration = 0

  private func bumpGeneration() -> Int {
    generationLock.lock(); defer { generationLock.unlock() }
    captureGeneration += 1
    return captureGeneration
  }

  private func isCurrentGeneration(_ generation: Int) -> Bool {
    generationLock.lock(); defer { generationLock.unlock() }
    return captureGeneration == generation
  }

  public func definition() -> ModuleDefinition {
    Name("SalcaraVoice")

    Events(
      "onLevel", "onPcm", "onTranscript", "onSpeech", "onUtterance", "onCaptureError",
      "onPlaybackLevel", "onPlaybackDone", "onSpeakDone"
    )

    OnCreate {
      self.audio.emit = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      let speaker = self.speaker
      self.audio.systemSpeaking = { speaker.speaking }
      self.speaker.onFinished = { [weak self] id in
        self?.sendEvent("onSpeakDone", ["id": id])
      }
    }

    Function("engineAvailable") { () -> Bool in
      return false
    }

    AsyncFunction("prepareRecognizer") { (options: RecognizerOptions) -> Bool in
      return false
    }

    Function("releaseRecognizer") { () -> Void in
      // Nothing to release: there is no on-device recognizer on iOS.
    }

    AsyncFunction("startCapture") { (options: CaptureOptions, promise: Promise) in
      let generation = self.bumpGeneration()
      let config = CaptureConfig(
        sampleRate: options.sampleRate, chunkMs: options.chunkMs, emitPcm: options.emitPcm,
        turnDetection: options.turnDetection, endSilenceMs: options.endSilenceMs,
        utteranceWav: options.utteranceWav, sessionWav: options.sessionWav, conversation: options.conversation
      )
      VoiceAudio.requestMicrophone { granted in
        if !granted {
          promise.reject("ERR_MIC_PERMISSION", "没有麦克风权限，请在“设置 → Salcara AI”中允许使用麦克风")
          return
        }
        self.audio.startCapture(config, isCurrent: { [weak self] in
          self?.isCurrentGeneration(generation) ?? false
        }) { result in
          switch result {
          case .success(let started):
            promise.resolve(started)
          case .failure(let error):
            promise.reject("ERR_CAPTURE", error.localizedDescription)
          }
        }
      }
    }

    AsyncFunction("stopCapture") { () -> StopCaptureResult in
      _ = self.bumpGeneration()
      var result = StopCaptureResult()
      result.uri = self.audio.stopCapture()
      return result
    }

    Function("cancelCapture") { () -> Void in
      _ = self.bumpGeneration()
      self.audio.cancelCapture()
    }

    Function("setMuted") { (muted: Bool) -> Void in
      self.audio.setMuted(muted)
    }

    Function("playerStart") { (sampleRate: Int, communication: Bool) -> Void in
      self.audio.playerStart(sampleRate: sampleRate, communication: communication)
    }

    Function("playerWrite") { (base64: String) -> Void in
      guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), !data.isEmpty else { return }
      self.audio.playerWrite(data)
    }

    Function("playerEnd") { () -> Void in
      self.audio.playerEnd()
    }

    Function("playerStop") { () -> Void in
      self.audio.playerStop()
    }

    Function("playerRelease") { () -> Void in
      self.audio.playerRelease()
    }

    Function("speak") { (text: String, id: String) -> Void in
      self.speaker.speak(text, id: id)
    }

    Function("stopSpeaking") { () -> Void in
      self.speaker.stop()
    }

    Function("endConversationAudio") { () -> Void in
      self.audio.endConversationAudio()
    }

    Function("deleteFile") { (uri: String) -> Bool in
      let url: URL
      if uri.hasPrefix("file://") {
        guard let parsed = URL(string: uri) else { return false }
        url = parsed
      } else {
        url = URL(fileURLWithPath: uri)
      }
      // Only our own recordings may be deleted through this call.
      guard url.isFileURL, url.deletingLastPathComponent().lastPathComponent == "salcara-voice" else { return false }
      do {
        try FileManager.default.removeItem(at: url)
        return true
      } catch {
        return false
      }
    }

    OnDestroy {
      _ = self.bumpGeneration()
      self.audio.shutdown()
      self.speaker.stop()
    }
  }
}
