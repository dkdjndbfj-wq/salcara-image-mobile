import AVFoundation
import Foundation

/**
 * iOS system text-to-speech (AVSpeechSynthesizer, zh-CN voice): free, offline
 * fallback for spoken replies. Every sentence reports onSpeakDone exactly once
 * when heard, cancelled or impossible — unless stop() dropped it, like Android.
 * All synthesizer work happens on the main thread.
 */
final class SystemSpeaker: NSObject, AVSpeechSynthesizerDelegate {
  private var synthesizer: AVSpeechSynthesizer?
  private var ids: [ObjectIdentifier: String] = [:]
  private let lock = NSLock()
  private var outstanding = 0
  var onFinished: (String) -> Void = { _ in }

  /** True while sentences are queued or being spoken (so our own voice is not taken as barge-in). */
  var speaking: Bool {
    lock.lock(); defer { lock.unlock() }
    return outstanding > 0
  }

  private func setOutstanding(_ value: Int) {
    lock.lock()
    outstanding = max(0, value)
    lock.unlock()
  }

  private static func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }

  private func engine() -> AVSpeechSynthesizer {
    if let synthesizer = synthesizer { return synthesizer }
    let created = AVSpeechSynthesizer()
    created.delegate = self
    synthesizer = created
    return created
  }

  func speak(_ text: String, id: String) {
    SystemSpeaker.onMain {
      let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if clean.isEmpty {
        self.onFinished(id)
        return
      }
      let utterance = AVSpeechUtterance(string: clean)
      utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN") ?? AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate
      self.ids[ObjectIdentifier(utterance)] = id
      self.setOutstanding(self.ids.count)
      self.engine().speak(utterance)
    }
  }

  func stop() {
    SystemSpeaker.onMain {
      self.ids.removeAll()
      self.setOutstanding(0)
      if let synthesizer = self.synthesizer, synthesizer.isSpeaking || synthesizer.isPaused {
        synthesizer.stopSpeaking(at: .immediate)
      }
    }
  }

  private func done(_ utterance: AVSpeechUtterance) {
    SystemSpeaker.onMain {
      guard let id = self.ids.removeValue(forKey: ObjectIdentifier(utterance)) else { return }
      self.setOutstanding(self.ids.count)
      self.onFinished(id)
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    done(utterance)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    done(utterance)
  }
}
