package expo.modules.salcaravoice

import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import java.io.File

private const val SAMPLE_RATE = 16000

/** Receives recognition results: partial text while speaking, then the final text of a sentence. */
typealias TranscriptSink = (text: String, isFinal: Boolean) -> Unit

/** One recognition pass over a microphone session. Not thread-safe: fed from the capture thread only. */
interface RecognizerSession {
  fun accept(samples: FloatArray)
  fun finish()
  fun release()
}

/**
 * Keeps the loaded model in memory between uses (loading takes a second or
 * two); a new session is created for every capture.
 */
class EngineCache {
  private var key: String? = null
  private var options: RecognizerOptions? = null
  private var online: OnlineRecognizer? = null
  private var offline: OfflineRecognizer? = null

  @Synchronized
  fun prepare(o: RecognizerOptions) {
    val nextKey = listOf(o.kind, o.encoder, o.decoder, o.joiner, o.model, o.tokens, o.vad, o.numThreads.toString(), o.endSilence.toString()).joinToString("|")
    if (nextKey == key && (online != null || offline != null)) return
    release()
    if (!nativeAvailable()) throw IllegalStateException("当前设备不支持本地语音识别（需要 64 位 ARM 处理器），请改用云端识别")
    fun need(path: String, label: String) {
      if (path.isEmpty() || !File(path).isFile) throw IllegalStateException("语音模型文件缺失（$label），请在设置中重新下载")
    }
    need(o.tokens, "tokens")
    when (o.kind) {
      "online-transducer" -> {
        need(o.encoder, "encoder"); need(o.decoder, "decoder"); need(o.joiner, "joiner")
        online = OnlineRecognizer(config = onlineConfig(o, OnlineModelConfig(
          transducer = OnlineTransducerModelConfig(encoder = o.encoder, decoder = o.decoder, joiner = o.joiner),
          tokens = o.tokens, numThreads = o.numThreads, provider = "cpu", modelType = "zipformer",
        )))
      }
      "online-paraformer" -> {
        need(o.encoder, "encoder"); need(o.decoder, "decoder")
        online = OnlineRecognizer(config = onlineConfig(o, OnlineModelConfig(
          paraformer = OnlineParaformerModelConfig(encoder = o.encoder, decoder = o.decoder),
          tokens = o.tokens, numThreads = o.numThreads, provider = "cpu", modelType = "paraformer",
        )))
      }
      "offline-sensevoice" -> {
        need(o.model, "model"); need(o.vad, "vad")
        offline = OfflineRecognizer(config = OfflineRecognizerConfig(
          featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
          modelConfig = OfflineModelConfig(
            senseVoice = OfflineSenseVoiceModelConfig(model = o.model, language = "auto", useInverseTextNormalization = true),
            tokens = o.tokens, numThreads = o.numThreads, provider = "cpu",
          ),
        ))
      }
      else -> throw IllegalArgumentException("未知的语音模型类型：${o.kind}")
    }
    key = nextKey
    options = o
  }

  @Synchronized
  fun isPrepared(): Boolean = online != null || offline != null

  @Synchronized
  fun newSession(sink: TranscriptSink): RecognizerSession {
    val o = options ?: throw IllegalStateException("语音模型尚未加载")
    online?.let { return OnlineSession(it, o.kind == "online-paraformer", sink) }
    offline?.let { return SenseVoiceSession(it, o, sink) }
    throw IllegalStateException("语音模型尚未加载")
  }

  @Synchronized
  fun release() {
    try { online?.release() } catch (_: Throwable) {}
    try { offline?.release() } catch (_: Throwable) {}
    online = null
    offline = null
    key = null
    options = null
  }

  private fun onlineConfig(o: RecognizerOptions, model: OnlineModelConfig) = OnlineRecognizerConfig(
    featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
    modelConfig = model,
    endpointConfig = EndpointConfig(
      rule1 = EndpointRule(false, 2.4f, 0.0f),
      rule2 = EndpointRule(true, o.endSilence, 0.0f),
      rule3 = EndpointRule(false, 0.0f, 20.0f),
    ),
    enableEndpoint = true,
  )

  companion object {
    @Volatile private var available: Boolean? = null

    fun nativeAvailable(): Boolean {
      available?.let { return it }
      val ok = try {
        System.loadLibrary("sherpa-onnx-jni")
        true
      } catch (_: Throwable) {
        false
      }
      available = ok
      return ok
    }
  }
}

/** Streaming Zipformer / Paraformer: text grows as you speak; an endpoint closes each sentence. */
private class OnlineSession(
  private val recognizer: OnlineRecognizer,
  private val paraformer: Boolean,
  private val sink: TranscriptSink,
) : RecognizerSession {
  private val stream: OnlineStream = recognizer.createStream()
  private var lastPartial = ""

  override fun accept(samples: FloatArray) {
    stream.acceptWaveform(samples, SAMPLE_RATE)
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    if (recognizer.isEndpoint(stream)) {
      if (paraformer) flushTail()
      val text = recognizer.getResult(stream).text.trim()
      if (text.isNotEmpty()) sink(text, true)
      recognizer.reset(stream)
      lastPartial = ""
      return
    }
    val text = recognizer.getResult(stream).text.trim()
    if (text != lastPartial) {
      lastPartial = text
      if (text.isNotEmpty()) sink(text, false)
    }
  }

  override fun finish() {
    flushTail()
    stream.inputFinished()
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    val text = recognizer.getResult(stream).text.trim()
    if (text.isNotEmpty()) sink(text, true)
    recognizer.reset(stream)
    lastPartial = ""
  }

  /** Paraformer needs trailing silence to emit its last characters. */
  private fun flushTail() {
    stream.acceptWaveform(FloatArray((0.8f * SAMPLE_RATE).toInt()), SAMPLE_RATE)
    while (recognizer.isReady(stream)) recognizer.decode(stream)
  }

  override fun release() {
    try { stream.release() } catch (_: Throwable) {}
  }
}

/**
 * SenseVoice is non-streaming, so Silero VAD cuts speech into sentences and
 * the sentence in progress is re-decoded every ~0.6 s to show live text.
 * SenseVoice adds punctuation itself.
 */
private class SenseVoiceSession(
  private val recognizer: OfflineRecognizer,
  options: RecognizerOptions,
  private val sink: TranscriptSink,
) : RecognizerSession {
  private val window = 512
  private val vad = Vad(config = VadModelConfig(
    sileroVadModelConfig = SileroVadModelConfig(
      model = options.vad,
      threshold = 0.5f,
      minSilenceDuration = options.endSilence,
      minSpeechDuration = 0.25f,
      windowSize = window,
      maxSpeechDuration = 20.0f,
    ),
    sampleRate = SAMPLE_RATE,
    numThreads = 1,
    provider = "cpu",
  ))
  private var pending = FloatArray(0)
  private val speech = FloatBuffer()
  private val preRoll = FloatBuffer()
  private var inSpeech = false
  private var samplesSincePartial = 0
  private var lastPartialCost = 0L

  override fun accept(samples: FloatArray) {
    val all = if (pending.isEmpty()) samples else pending + samples
    var offset = 0
    while (offset + window <= all.size) {
      val chunk = all.copyOfRange(offset, offset + window)
      offset += window
      vad.acceptWaveform(chunk)
      val speaking = vad.isSpeechDetected()
      if (speaking && !inSpeech) {
        inSpeech = true
        speech.clear()
        speech.append(preRoll.toArray())
        samplesSincePartial = 0
      }
      if (inSpeech) speech.append(chunk) else preRoll.appendKeepingLast(chunk, SAMPLE_RATE / 3)
      while (!vad.empty()) {
        val segment = vad.front()
        vad.pop()
        val text = decode(segment.samples)
        if (text.isNotEmpty()) sink(text, true)
        inSpeech = false
        speech.clear()
      }
      if (inSpeech) {
        samplesSincePartial += window
        val interval = maxOf(SAMPLE_RATE * 6 / 10, (lastPartialCost * 2 * SAMPLE_RATE / 1000).toInt())
        if (samplesSincePartial >= interval && speech.size in (SAMPLE_RATE / 2)..(SAMPLE_RATE * 15)) {
          samplesSincePartial = 0
          val started = System.currentTimeMillis()
          val text = decode(speech.toArray())
          lastPartialCost = System.currentTimeMillis() - started
          if (text.isNotEmpty()) sink(text, false)
        }
      }
    }
    pending = if (offset < all.size) all.copyOfRange(offset, all.size) else FloatArray(0)
  }

  override fun finish() {
    vad.flush()
    var emitted = false
    while (!vad.empty()) {
      val segment = vad.front()
      vad.pop()
      val text = decode(segment.samples)
      if (text.isNotEmpty()) { sink(text, true); emitted = true }
    }
    if (!emitted && inSpeech && speech.size > SAMPLE_RATE / 4) {
      val text = decode(speech.toArray())
      if (text.isNotEmpty()) sink(text, true)
    }
    inSpeech = false
    speech.clear()
  }

  private fun decode(samples: FloatArray): String {
    val stream = recognizer.createStream()
    try {
      stream.acceptWaveform(samples, SAMPLE_RATE)
      recognizer.decode(stream)
      return recognizer.getResult(stream).text.trim()
    } finally {
      stream.release()
    }
  }

  override fun release() {
    try { vad.release() } catch (_: Throwable) {}
  }
}

/** Growable float buffer without boxing. */
private class FloatBuffer {
  private var data = FloatArray(SAMPLE_RATE)
  var size = 0
    private set

  fun append(values: FloatArray) {
    if (size + values.size > data.size) data = data.copyOf(maxOf(data.size * 2, size + values.size))
    System.arraycopy(values, 0, data, size, values.size)
    size += values.size
  }

  fun appendKeepingLast(values: FloatArray, keep: Int) {
    append(values)
    if (size > keep) {
      System.arraycopy(data, size - keep, data, 0, keep)
      size = keep
    }
  }

  fun toArray(): FloatArray = data.copyOf(size)

  fun clear() { size = 0 }
}
