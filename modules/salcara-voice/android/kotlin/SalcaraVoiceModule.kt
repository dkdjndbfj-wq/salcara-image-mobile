package expo.modules.salcaravoice

import android.content.Context
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

class RecognizerOptions : Record {
  /** online-transducer | online-paraformer | offline-sensevoice */
  @Field var kind: String = ""
  @Field var encoder: String = ""
  @Field var decoder: String = ""
  @Field var joiner: String = ""
  @Field var model: String = ""
  @Field var tokens: String = ""
  @Field var vad: String = ""
  @Field var numThreads: Int = 2
  /** Seconds of silence that end a sentence. */
  @Field var endSilence: Float = 0.8f
}

class CaptureOptions : Record {
  @Field var sampleRate: Int = 16000
  @Field var chunkMs: Int = 40
  /** Stream raw PCM16 to JS (realtime voice models). */
  @Field var emitPcm: Boolean = false
  /** Run the prepared on-device recognizer (16 kHz only). */
  @Field var useRecognizer: Boolean = false
  /** Emit onSpeech start/stop from energy-based turn detection. */
  @Field var turnDetection: Boolean = false
  @Field var endSilenceMs: Int = 800
  /** Write each detected utterance to a WAV file (cloud transcription in conversation). */
  @Field var utteranceWav: Boolean = false
  /** Write the whole capture to a WAV file (cloud dictation). */
  @Field var sessionWav: Boolean = false
  /** Hands-free conversation: echo cancellation, noise suppression, speakerphone. */
  @Field var conversation: Boolean = false
}

class SalcaraVoiceModule : Module() {
  private val engines = EngineCache()
  @Volatile private var capture: VoiceCapture? = null
  /** Bumped by every start / stop / cancel, so a start that a cancel overtook is undone. */
  private val captureGeneration = AtomicInteger(0)
  private var player: PcmPlayer? = null
  private var speaker: SystemSpeaker? = null
  private var conversationAudio: ConversationAudio? = null

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("应用上下文不可用")

  override fun definition() = ModuleDefinition {
    Name("SalcaraVoice")

    Events(
      "onLevel", "onPcm", "onTranscript", "onSpeech", "onUtterance", "onCaptureError",
      "onPlaybackLevel", "onPlaybackDone", "onSpeakDone",
    )

    Function("engineAvailable") { ->
      EngineCache.nativeAvailable()
    }

    AsyncFunction("prepareRecognizer") { options: RecognizerOptions ->
      // Never swap the model under a running capture thread.
      stopCaptureInternal(false)
      engines.prepare(options)
      true
    }

    Function("releaseRecognizer") { ->
      captureGeneration.incrementAndGet()
      stopCaptureInternal(false)
      engines.release()
    }

    AsyncFunction("startCapture") { options: CaptureOptions ->
      val generation = captureGeneration.incrementAndGet()
      stopCaptureInternal(false)
      val session = if (options.useRecognizer) {
        engines.newSession { text, isFinal -> sendEvent("onTranscript", mapOf("text" to text, "isFinal" to isFinal)) }
      } else null
      if (options.conversation) {
        val audio = conversationAudio ?: ConversationAudio(context).also { conversationAudio = it }
        audio.enter()
      }
      val next = VoiceCapture(context, options, session, object : CaptureListener {
        override fun onLevel(level: Double) = sendEvent("onLevel", mapOf("level" to level))
        override fun onPcm(base64: String) = sendEvent("onPcm", mapOf("data" to base64))
        override fun onTranscript(text: String, isFinal: Boolean) = sendEvent("onTranscript", mapOf("text" to text, "isFinal" to isFinal))
        override fun onSpeech(speaking: Boolean) = sendEvent("onSpeech", mapOf("speaking" to speaking))
        override fun onUtterance(path: String, durationMs: Long) = sendEvent("onUtterance", mapOf("uri" to path, "durationMs" to durationMs.toDouble()))
        override fun onError(message: String) = sendEvent("onCaptureError", mapOf("message" to message))
      }, { player?.active == true || speaker?.speaking == true })
      try {
        next.start()
      } catch (t: Throwable) {
        session?.release()
        conversationAudio?.exit()
        throw t
      }
      if (captureGeneration.get() != generation) {
        // Cancelled while the microphone was opening.
        next.stop(false)
        conversationAudio?.exit()
        return@AsyncFunction false
      }
      capture = next
      true
    }

    AsyncFunction("stopCapture") { ->
      captureGeneration.incrementAndGet()
      mapOf("uri" to stopCaptureInternal(true))
    }

    Function("cancelCapture") { ->
      captureGeneration.incrementAndGet()
      stopCaptureInternal(false)
      Unit
    }

    Function("setMuted") { muted: Boolean ->
      capture?.setMuted(muted)
    }

    Function("playerStart") { sampleRate: Int, communication: Boolean ->
      val current = player
      if (current == null || current.sampleRate != sampleRate) {
        current?.release()
        player = PcmPlayer(sampleRate, communication, object : PlaybackListener {
          override fun onLevel(level: Double) = sendEvent("onPlaybackLevel", mapOf("level" to level))
          override fun onDone(interrupted: Boolean) = sendEvent("onPlaybackDone", mapOf("interrupted" to interrupted))
        })
      }
    }

    Function("playerWrite") { base64: String ->
      player?.write(Base64.decode(base64, Base64.DEFAULT))
    }

    Function("playerEnd") { ->
      player?.end()
    }

    Function("playerStop") { ->
      player?.flush()
    }

    Function("playerRelease") { ->
      player?.release()
      player = null
    }

    Function("speak") { text: String, id: String ->
      val current = speaker ?: SystemSpeaker(context) { utterance -> sendEvent("onSpeakDone", mapOf("id" to utterance)) }.also { speaker = it }
      current.speak(text, id)
    }

    Function("stopSpeaking") { ->
      speaker?.stop()
    }

    Function("endConversationAudio") { ->
      conversationAudio?.exit()
    }

    Function("deleteFile") { uri: String ->
      val path = uri.removePrefix("file://")
      val file = File(path)
      // Only our own recordings may be deleted through this call.
      if (file.parentFile?.name == "salcara-voice") file.delete() else false
    }

    OnDestroy {
      stopCaptureInternal(false)
      player?.release()
      player = null
      speaker?.shutdown()
      speaker = null
      conversationAudio?.exit()
      engines.release()
    }
  }

  @Synchronized
  private fun stopCaptureInternal(finish: Boolean): String? {
    val current = capture ?: return null
    capture = null
    val uri = current.stop(finish)
    conversationAudio?.exit()
    return uri
  }
}
