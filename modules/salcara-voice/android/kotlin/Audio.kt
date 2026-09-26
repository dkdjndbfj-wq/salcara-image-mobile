package expo.modules.salcaravoice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.log10
import kotlin.math.sqrt

interface CaptureListener {
  fun onLevel(level: Double)
  fun onPcm(base64: String)
  fun onTranscript(text: String, isFinal: Boolean)
  fun onSpeech(speaking: Boolean)
  fun onUtterance(path: String, durationMs: Long)
  fun onError(message: String)
}

/** Maps RMS to a 0…1 level that feels natural for animation (−55 dBFS … −10 dBFS). */
fun levelFromRms(rms: Double): Double {
  val db = 20.0 * log10(rms + 1e-7)
  return ((db + 55.0) / 45.0).coerceIn(0.0, 1.0)
}

fun rmsOf(samples: ShortArray, count: Int): Double {
  if (count <= 0) return 0.0
  var sum = 0.0
  for (i in 0 until count) {
    val v = samples[i] / 32768.0
    sum += v * v
  }
  return sqrt(sum / count)
}

/**
 * Energy-based turn detection with an adaptive noise floor. While the
 * assistant is talking the threshold is raised, so its own voice (after echo
 * cancellation) does not count as the user interrupting.
 */
class TurnDetector(private val endSilenceMs: Int) {
  private var noiseFloor = 0.004
  private var speechMs = 0
  private var silenceMs = 0
  var speaking = false
    private set

  /** Returns true when speech starts, false when it ends, null otherwise. */
  fun process(rms: Double, durationMs: Int, strict: Boolean): Boolean? {
    val boost = if (strict) 2.6 else 1.0
    if (!speaking) {
      val start = maxOf(noiseFloor * 3.0, 0.012) * boost
      if (rms > start) {
        speechMs += durationMs
        if (speechMs >= 200) { speaking = true; silenceMs = 0; return true }
      } else {
        speechMs = 0
        noiseFloor = noiseFloor * 0.95 + rms * 0.05
      }
    } else {
      val keep = maxOf(noiseFloor * 2.0, 0.008) * boost
      if (rms < keep) {
        silenceMs += durationMs
        if (silenceMs >= endSilenceMs) { speaking = false; speechMs = 0; return false }
      } else {
        silenceMs = 0
      }
    }
    return null
  }
}

/** Minimal 16-bit mono WAV writer (header patched on close). */
class WavWriter(val file: File, private val sampleRate: Int) {
  private val out = RandomAccessFile(file, "rw")
  private var dataBytes = 0L

  init {
    out.setLength(0)
    out.write(ByteArray(44))
  }

  fun write(bytes: ByteArray) {
    out.write(bytes)
    dataBytes += bytes.size
  }

  fun durationMs(): Long = dataBytes * 1000 / (sampleRate * 2L)

  fun close(): Long {
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray(Charsets.US_ASCII)).putInt((36 + dataBytes).toInt())
    header.put("WAVE".toByteArray(Charsets.US_ASCII)).put("fmt ".toByteArray(Charsets.US_ASCII))
    header.putInt(16).putShort(1.toShort()).putShort(1.toShort()).putInt(sampleRate).putInt(sampleRate * 2)
    header.putShort(2.toShort()).putShort(16.toShort())
    header.put("data".toByteArray(Charsets.US_ASCII)).putInt(dataBytes.toInt())
    out.seek(0)
    out.write(header.array())
    out.close()
    return dataBytes
  }
}

/**
 * Microphone capture on its own thread: level meter, optional PCM streaming,
 * turn detection, per-utterance / whole-session WAV and on-device recognition.
 */
class VoiceCapture(
  private val context: Context,
  private val options: CaptureOptions,
  private val recognizer: RecognizerSession?,
  private val listener: CaptureListener,
  private val isPlaying: () -> Boolean,
) {
  @Volatile private var running = false
  private var thread: Thread? = null
  private var record: AudioRecord? = null
  private var echo: AcousticEchoCanceler? = null
  private var noise: NoiseSuppressor? = null
  private var sessionWav: WavWriter? = null
  private var utteranceWav: WavWriter? = null
  private val turns = TurnDetector(options.endSilenceMs)
  private val preRoll = ArrayDeque<ByteArray>()
  private var preRollBytes = 0
  @Volatile private var muted = false

  fun setMuted(value: Boolean) { muted = value }

  @SuppressLint("MissingPermission")
  fun start() {
    val rate = options.sampleRate
    val minBuffer = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer <= 0) throw IllegalStateException("麦克风不支持 ${rate}Hz 采样")
    val source = if (options.conversation) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
    val created = AudioRecord(source, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuffer * 4, rate * 2 * 2))
    if (created.state != AudioRecord.STATE_INITIALIZED) {
      created.release()
      throw IllegalStateException("无法打开麦克风，请检查录音权限或是否被其他应用占用")
    }
    record = created
    if (options.conversation) {
      if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(created.audioSessionId)?.also { it.setEnabled(true) }
      if (NoiseSuppressor.isAvailable()) noise = NoiseSuppressor.create(created.audioSessionId)?.also { it.setEnabled(true) }
    }
    if (options.sessionWav) sessionWav = WavWriter(newFile("dictation"), rate)
    created.startRecording()
    running = true
    thread = Thread({ loop(created) }, "salcara-voice-capture").apply { start() }
  }

  private fun newFile(prefix: String): File {
    val dir = File(context.cacheDir, "salcara-voice").apply { mkdirs() }
    return File(dir, "$prefix-${System.currentTimeMillis()}.wav")
  }

  private fun loop(audio: AudioRecord) {
    val rate = options.sampleRate
    val chunk = maxOf(160, rate * options.chunkMs / 1000)
    val shorts = ShortArray(chunk)
    val bytes = ByteBuffer.allocate(chunk * 2).order(ByteOrder.LITTLE_ENDIAN)
    try {
      while (running) {
        val n = audio.read(shorts, 0, chunk)
        if (n < 0) {
          // ERROR_INVALID_OPERATION / ERROR_DEAD_OBJECT: the mic is gone; don't spin.
          if (running) listener.onError("麦克风已被系统或其他应用占用（错误码 $n）")
          break
        }
        if (n == 0) continue
        if (muted) {
          java.util.Arrays.fill(shorts, 0, n, 0.toShort())
        }
        val rms = rmsOf(shorts, n)
        listener.onLevel(levelFromRms(rms))
        bytes.clear()
        bytes.asShortBuffer().put(shorts, 0, n)
        val pcm = ByteArray(n * 2)
        System.arraycopy(bytes.array(), 0, pcm, 0, n * 2)
        if (options.emitPcm) listener.onPcm(Base64.encodeToString(pcm, Base64.NO_WRAP))
        sessionWav?.write(pcm)
        if (options.turnDetection) handleTurns(rms, n * 1000 / rate, pcm)
        if (recognizer != null && rate == 16000) {
          val floats = FloatArray(n) { shorts[it] / 32768f }
          recognizer.accept(floats)
        }
      }
    } catch (t: Throwable) {
      if (running) listener.onError(t.message ?: "录音出错")
    }
  }

  private fun handleTurns(rms: Double, durationMs: Int, pcm: ByteArray) {
    when (turns.process(rms, durationMs, isPlaying())) {
      true -> {
        listener.onSpeech(true)
        if (options.utteranceWav) {
          utteranceWav = WavWriter(newFile("utterance"), options.sampleRate).also { writer ->
            preRoll.forEach { writer.write(it) }
          }
        }
      }
      false -> {
        listener.onSpeech(false)
        utteranceWav?.let { writer ->
          writer.write(pcm)
          val duration = writer.durationMs()
          writer.close()
          utteranceWav = null
          if (duration >= 350) listener.onUtterance("file://" + writer.file.absolutePath, duration)
          else writer.file.delete()
        }
        return
      }
      null -> {}
    }
    utteranceWav?.write(pcm)
    if (utteranceWav == null) {
      preRoll.addLast(pcm)
      preRollBytes += pcm.size
      val limit = options.sampleRate * 2 * 4 / 10
      while (preRollBytes > limit && preRoll.isNotEmpty()) preRollBytes -= preRoll.removeFirst().size
    }
  }

  /** Stops the microphone, finishes recognition and returns the session WAV (if requested). */
  fun stop(finishRecognition: Boolean): String? {
    running = false
    try { record?.stop() } catch (_: Throwable) {}
    try { thread?.join(4000) } catch (_: InterruptedException) {}
    // Only touch the recognizer once the capture thread has really left it;
    // freeing native state it is still using would crash the app.
    val threadDone = thread?.isAlive != true
    if (threadDone) {
      if (finishRecognition) {
        try { recognizer?.finish() } catch (t: Throwable) { listener.onError(t.message ?: "识别出错") }
      }
      try { recognizer?.release() } catch (_: Throwable) {}
    }
    try { echo?.release() } catch (_: Throwable) {}
    try { noise?.release() } catch (_: Throwable) {}
    try { record?.release() } catch (_: Throwable) {}
    record = null
    utteranceWav?.let { it.close(); it.file.delete() }
    utteranceWav = null
    val wav = sessionWav ?: return null
    sessionWav = null
    val bytes = wav.close()
    return if (bytes > 0) "file://" + wav.file.absolutePath else null
  }
}

interface PlaybackListener {
  fun onLevel(level: Double)
  fun onDone(interrupted: Boolean)
}

/** Streaming 16-bit mono PCM playback (TTS / realtime audio) with a drained-callback. */
class PcmPlayer(val sampleRate: Int, communication: Boolean, private val listener: PlaybackListener) {
  // Declared before init: the writer thread started there uses them immediately.
  private val lock = Any()
  /** Bumped by flush(): chunks taken before a flush are dropped instead of played. */
  @Volatile private var epoch = 0
  private val queue = LinkedBlockingQueue<ByteArray>()
  @Volatile private var running = true
  @Volatile private var endRequested = false
  @Volatile private var writtenFrames = 0L
  @Volatile var active = false
    private set
  private val track: AudioTrack
  private val thread: Thread

  init {
    val minBuffer = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    track = AudioTrack.Builder()
      .setAudioAttributes(AudioAttributes.Builder()
        .setUsage(if (communication) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build())
      .setAudioFormat(AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(sampleRate)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build())
      .setBufferSizeInBytes(maxOf(minBuffer * 2, sampleRate / 5 * 2))
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
    track.play()
    thread = Thread({ loop() }, "salcara-voice-player").apply { start() }
  }

  fun write(data: ByteArray) {
    if (data.isEmpty()) return
    synchronized(lock) {
      endRequested = false
      active = true
      queue.offer(data)
    }
  }

  /** No more audio for this reply: report onDone once everything has been heard. */
  fun end() { endRequested = true }

  /** Stop immediately (user interrupted). */
  fun flush() {
    val wasActive: Boolean
    synchronized(lock) {
      epoch += 1
      queue.clear()
      endRequested = false
      try {
        track.pause()
        track.flush()
        track.play()
      } catch (_: Throwable) {}
      writtenFrames = 0
      wasActive = active
      active = false
    }
    if (wasActive) {
      listener.onLevel(0.0)
      listener.onDone(true)
    }
  }

  private fun loop() {
    var lastLevelAt = 0L
    while (running) {
      val takenEpoch = epoch
      val data = try { queue.poll(40, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { null }
      if (data != null) {
        if (takenEpoch != epoch) continue
        val shorts = ShortArray(data.size / 2)
        ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
        val now = System.currentTimeMillis()
        if (now - lastLevelAt > 45) {
          lastLevelAt = now
          listener.onLevel(levelFromRms(rmsOf(shorts, shorts.size)))
        }
        var offset = 0
        while (offset < data.size && running) {
          val written = track.write(data, offset, data.size - offset)
          if (written <= 0) break
          offset += written
        }
        writtenFrames += (data.size / 2).toLong()
        continue
      }
      var finished = false
      synchronized(lock) {
        if (endRequested && queue.isEmpty() && active) {
          val head = track.playbackHeadPosition.toLong() and 0xFFFFFFFFL
          if (head >= writtenFrames - sampleRate / 50 || writtenFrames == 0L) {
            endRequested = false
            active = false
            writtenFrames = 0
            try { track.pause(); track.flush(); track.play() } catch (_: Throwable) {}
            finished = true
          }
        }
      }
      if (finished) {
        listener.onLevel(0.0)
        listener.onDone(false)
      }
    }
  }

  fun release() {
    running = false
    queue.clear()
    try { thread.join(300) } catch (_: InterruptedException) {}
    try { track.stop() } catch (_: Throwable) {}
    track.release()
  }
}

/** Android's built-in text-to-speech: free, offline fallback for spoken replies. */
class SystemSpeaker(context: Context, private val onFinished: (String) -> Unit) : TextToSpeech.OnInitListener {
  private val lock = Any()
  @Volatile private var engine: TextToSpeech? = null
  private var earlyStatus: Int? = null
  @Volatile private var ready = false
  @Volatile private var failed = false
  private val pending = ArrayList<Pair<String, String>>()
  private val outstanding = java.util.Collections.synchronizedSet(HashSet<String>())

  init {
    // onInit may arrive on the main thread before the constructor returns; whichever
    // side comes second runs setup exactly once.
    val created = TextToSpeech(context.applicationContext, this)
    val early = synchronized(lock) { engine = created; earlyStatus }
    if (early != null) setup(early)
  }

  /** True while sentences are queued or being spoken (used to ignore our own voice as "barge-in"). */
  val speaking: Boolean
    get() = outstanding.isNotEmpty()

  private fun done(id: String) {
    outstanding.remove(id)
    onFinished(id)
  }

  override fun onInit(status: Int) {
    val attached = synchronized(lock) {
      if (engine == null) { earlyStatus = status; false } else true
    }
    if (attached) setup(status)
  }

  private fun setup(status: Int) {
    val tts = engine ?: return
    if (status != TextToSpeech.SUCCESS) {
      // No usable engine: report every queued sentence as finished so the UI never hangs.
      val queued = synchronized(pending) { failed = true; ArrayList(pending).also { pending.clear() } }
      queued.forEach { (_, id) -> done(id) }
      return
    }
    // Same stream family as the microphone's echo canceller, so our own voice is cancelled out.
    tts.setAudioAttributes(AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build())
    val result = tts.setLanguage(Locale.SIMPLIFIED_CHINESE)
    if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(Locale.getDefault())
    tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {}
      override fun onDone(utteranceId: String?) { done(utteranceId ?: "") }
      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) { done(utteranceId ?: "") }
      override fun onStop(utteranceId: String?, interrupted: Boolean) { done(utteranceId ?: "") }
    })
    val queued = synchronized(pending) { ready = true; ArrayList(pending).also { pending.clear() } }
    queued.forEach { (text, id) -> say(tts, text, id) }
  }

  private fun say(tts: TextToSpeech, text: String, id: String) {
    if (tts.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id) != TextToSpeech.SUCCESS) done(id)
  }

  fun speak(text: String, id: String) {
    outstanding.add(id)
    val tts = synchronized(pending) {
      if (failed) null
      else if (!ready) { pending.add(text to id); return }
      else engine
    }
    if (tts == null) done(id) else say(tts, text, id)
  }

  fun stop() {
    synchronized(pending) { pending.clear() }
    if (ready) engine?.stop()
    outstanding.clear()
  }

  fun shutdown() {
    stop()
    engine?.shutdown()
  }
}

/** Speakerphone + communication mode for hands-free conversation (echo cancellation works best here). */
class ConversationAudio(context: Context) {
  private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var active = false
  private var previousMode = AudioManager.MODE_NORMAL

  fun enter() {
    if (active) return
    active = true
    previousMode = manager.mode
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    if (headsetConnected()) return
    if (Build.VERSION.SDK_INT >= 31) {
      manager.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { manager.setCommunicationDevice(it) }
    } else {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = true
    }
  }

  fun exit() {
    if (!active) return
    active = false
    if (Build.VERSION.SDK_INT >= 31) {
      manager.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = false
    }
    manager.mode = previousMode
  }

  private fun headsetConnected(): Boolean {
    val types = mutableSetOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_USB_HEADSET,
    )
    if (Build.VERSION.SDK_INT >= 31) types.add(AudioDeviceInfo.TYPE_BLE_HEADSET)
    return manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in types }
  }
}
