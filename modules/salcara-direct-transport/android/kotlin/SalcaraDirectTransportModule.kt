package expo.modules.salcaradirecttransport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class SalcaraDirectTransportModule : Module() {
  private val lock = Any()
  private var generation = 0L
  private var socket: WebSocket? = null
  private var client: OkHttpClient? = null

  override fun definition() = ModuleDefinition {
    Name("SalcaraDirectTransport")
    Events("onState", "onMessage", "onError")

    Function("connect") { url: String, certificateSha256: String ->
      connectPinned(url, certificateSha256)
    }

    Function("send") { text: String -> sendText(text) }

    Function("close") { closeSocket(true) }

    OnDestroy { closeSocket(false) }
  }

  private fun validateEndpoint(raw: String, fingerprint: String): URI {
    if (!fingerprint.matches(Regex("^[a-f0-9]{64}$"))) {
      throw IllegalArgumentException("电脑证书指纹无效，请重新扫描直连二维码")
    }
    val uri = try { URI(raw) } catch (_: Exception) { throw IllegalArgumentException("直连地址无效") }
    if (uri.scheme != "wss" || uri.host.isNullOrBlank() || uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null || uri.path != "/direct/ws") {
      throw IllegalArgumentException("直连地址无效；必须是二维码中的安全 WSS 地址")
    }
    return uri
  }

  private fun connectPinned(rawUrl: String, fingerprint: String) {
    val uri = validateEndpoint(rawUrl, fingerprint)
    val expected = fingerprint.lowercase()
    val trustManager = object : X509TrustManager {
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("客户端证书未配置")
      }

      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("电脑证书缺失")
        leaf.checkValidity()
        val actual = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        if (!MessageDigest.isEqual(actual.toByteArray(Charsets.US_ASCII), expected.toByteArray(Charsets.US_ASCII))) {
          throw CertificateException("电脑证书指纹不匹配")
        }
      }
    }
    val ssl = SSLContext.getInstance("TLS")
    ssl.init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
    // Keep OkHttp's default hostname verifier. Certificate pinning authenticates
    // the expected computer; hostname/SAN verification is a separate required check.
    val nextClient = OkHttpClient.Builder()
      .sslSocketFactory(ssl.socketFactory, trustManager)
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .build()
    val attempt: Long
    synchronized(lock) {
      generation += 1
      attempt = generation
      socket?.cancel()
      client?.dispatcher?.cancelAll()
      client?.dispatcher?.executorService?.shutdown()
      socket = null
      client = nextClient
    }
    sendEvent("onState", mapOf("state" to "connecting"))
    val request = Request.Builder().url(uri.toString()).build()
    val nextSocket = nextClient.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        if (!isCurrent(attempt, webSocket)) { webSocket.cancel(); return }
        sendEvent("onState", mapOf("state" to "open"))
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (!isCurrent(attempt, webSocket)) return
        if (text.toByteArray(Charsets.UTF_8).size > 256 * 1024) {
          fail(attempt, webSocket, "直连消息超出大小限制")
          return
        }
        sendEvent("onMessage", mapOf("text" to text))
      }

      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (!isCurrent(attempt, webSocket)) return
        if (bytes.size > 256 * 1024) fail(attempt, webSocket, "直连消息超出大小限制")
        else sendEvent("onError", mapOf("message" to "直连只接受 JSON 文本消息"))
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, null)
        if (isCurrent(attempt, webSocket)) sendEvent("onState", mapOf("state" to "closing"))
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        finish(attempt, webSocket)
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (!isCurrent(attempt, webSocket)) return
        val message = if (t.cause is CertificateException || t.message?.contains("certificate", true) == true) "电脑证书校验失败，直连已停止"
          else "电脑直连失败：${t.message?.take(160) ?: "连接不可用"}"
        sendEvent("onError", mapOf("message" to message))
        finish(attempt, webSocket)
      }
    })
    synchronized(lock) {
      if (generation == attempt) socket = nextSocket else nextSocket.cancel()
    }
  }

  private fun isCurrent(attempt: Long, candidate: WebSocket): Boolean = synchronized(lock) {
    generation == attempt && (socket == null || socket === candidate)
  }

  private fun sendText(text: String): Boolean {
    if (text.isEmpty() || text.toByteArray(Charsets.UTF_8).size > 256 * 1024) throw IllegalArgumentException("直连消息超出大小限制")
    val current = synchronized(lock) { socket } ?: throw IllegalStateException("电脑直连尚未就绪")
    if (!current.send(text)) throw IllegalStateException("电脑直连发送队列已关闭")
    return true
  }

  private fun fail(attempt: Long, candidate: WebSocket, message: String) {
    if (!isCurrent(attempt, candidate)) return
    sendEvent("onError", mapOf("message" to message))
    candidate.close(1009, "message too large")
    finish(attempt, candidate)
  }

  private fun finish(attempt: Long, candidate: WebSocket) {
    val shouldPublish = synchronized(lock) {
      if (generation != attempt || socket != null && socket !== candidate) false
      else {
        // Also fences callbacks that finish before newWebSocket() returns and
        // before its WebSocket handle can be stored in `socket`.
        generation += 1
        socket = null
        client?.dispatcher?.executorService?.shutdown()
        client = null
        true
      }
    }
    if (shouldPublish) sendEvent("onState", mapOf("state" to "closed"))
  }

  private fun closeSocket(publish: Boolean) {
    val closing = synchronized(lock) {
      generation += 1
      val previous = socket
      socket = null
      client?.dispatcher?.cancelAll()
      client?.dispatcher?.executorService?.shutdown()
      client = null
      previous
    }
    if (closing != null) {
      if (publish) sendEvent("onState", mapOf("state" to "closing"))
      closing.close(1000, "closed by user")
    }
    if (publish) sendEvent("onState", mapOf("state" to "closed"))
  }
}
