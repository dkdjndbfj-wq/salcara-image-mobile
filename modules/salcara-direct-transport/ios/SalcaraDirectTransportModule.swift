import CryptoKit
import ExpoModulesCore
import Foundation
import Security

public final class SalcaraDirectTransportModule: Module, URLSessionDelegate, URLSessionWebSocketDelegate {
  private let lock = NSLock()
  private var generation: UInt64 = 0
  private var pinnedFingerprint = ""
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?

  public func definition() -> ModuleDefinition {
    Name("SalcaraDirectTransport")
    Events("onState", "onMessage", "onError")

    Function("connect") { (url: String, certificateSha256: String) throws in
      try self.connectPinned(url, fingerprint: certificateSha256)
    }

    Function("send") { (text: String) throws -> Bool in
      try self.sendText(text)
    }

    Function("close") { self.closeSocket(publish: true) }

    OnDestroy { self.closeSocket(publish: false) }
  }

  private func validatedURL(_ raw: String, fingerprint: String) throws -> URL {
    guard fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
      throw transportError("电脑证书指纹无效，请重新扫描直连二维码")
    }
    guard let components = URLComponents(string: raw), components.scheme == "wss",
      let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
      components.path == "/direct/ws", components.query == nil, components.fragment == nil,
      let url = components.url else {
      throw transportError("直连地址无效；必须是二维码中的安全 WSS 地址")
    }
    return url
  }

  private func connectPinned(_ raw: String, fingerprint: String) throws {
    let url = try validatedURL(raw, fingerprint: fingerprint)
    closeSocket(publish: false)
    lock.lock()
    generation &+= 1
    let attempt = generation
    pinnedFingerprint = fingerprint
    let config = URLSessionConfiguration.ephemeral
    config.waitsForConnectivity = false
    let nextSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    let nextTask = nextSession.webSocketTask(with: url)
    session = nextSession
    task = nextTask
    lock.unlock()

    sendEvent("onState", ["state": "connecting"])
    nextTask.resume()
    receiveNext(from: nextTask, generation: attempt)
  }

  private func receiveNext(from socket: URLSessionWebSocketTask, generation attempt: UInt64) {
    socket.receive { [weak self, weak socket] result in
      guard let self, let socket, self.isCurrent(attempt, socket) else { return }
      switch result {
      case .success(.string(let text)):
        guard text.lengthOfBytes(using: .utf8) <= 256 * 1024 else {
          self.sendEvent("onError", ["message": "直连消息超出大小限制"])
          self.closeSocket(publish: true)
          return
        }
        self.sendEvent("onMessage", ["text": text])
        self.receiveNext(from: socket, generation: attempt)
      case .success(.data(let data)):
        if data.count > 256 * 1024 {
          self.sendEvent("onError", ["message": "直连消息超出大小限制"])
          self.closeSocket(publish: true)
          return
        }
        self.sendEvent("onError", ["message": "直连只接受 JSON 文本消息"])
        self.receiveNext(from: socket, generation: attempt)
      case .failure(let error):
        self.sendEvent("onError", ["message": self.errorMessage(error)])
        self.finish(attempt, socket)
      @unknown default:
        self.sendEvent("onError", ["message": "直连收到不支持的消息"])
        self.finish(attempt, socket)
      }
    }
  }

  private func sendText(_ text: String) throws -> Bool {
    guard !text.isEmpty, text.lengthOfBytes(using: .utf8) <= 256 * 1024 else {
      throw transportError("直连消息无效或超出大小限制")
    }
    lock.lock()
    let current = task
    let attempt = generation
    lock.unlock()
    guard let current else { throw transportError("电脑直连尚未就绪") }
    current.send(.string(text)) { [weak self] error in
      // URLSession may complete a queued send after this socket was retired
      // and a different direct pairing has already become active. Never let
      // that stale callback surface an error against the replacement socket.
      guard let self, let error, self.isCurrent(attempt, current) else { return }
      self.sendEvent("onError", ["message": self.errorMessage(error)])
    }
    return true
  }

  private func closeSocket(publish: Bool) {
    lock.lock()
    generation &+= 1
    let currentTask = task
    let currentSession = session
    task = nil
    session = nil
    pinnedFingerprint = ""
    lock.unlock()
    if currentTask != nil && publish { sendEvent("onState", ["state": "closing"]) }
    currentTask?.cancel(with: .normalClosure, reason: nil)
    currentSession?.invalidateAndCancel()
    if publish { sendEvent("onState", ["state": "closed"]) }
  }

  private func finish(_ attempt: UInt64, _ socket: URLSessionWebSocketTask) {
    lock.lock()
    guard generation == attempt, task === socket else { lock.unlock(); return }
    task = nil
    let currentSession = session
    session = nil
    pinnedFingerprint = ""
    lock.unlock()
    currentSession?.invalidateAndCancel()
    sendEvent("onState", ["state": "closed"])
  }

  private func isCurrent(_ attempt: UInt64, _ socket: URLSessionWebSocketTask) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return generation == attempt && task === socket
  }

  public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                         completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      publishPinError(for: session, message: "电脑证书类型无效，直连已停止")
      return
    }

    lock.lock()
    let isOwnedSession = self.session === session
    let expected = pinnedFingerprint
    lock.unlock()
    guard isOwnedSession, !expected.isEmpty,
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      publishPinError(for: session, message: "电脑直连身份无法确认")
      return
    }

    let certificateData = SecCertificateCopyData(leaf) as Data
    let actual = SHA256.hash(data: certificateData).map { String(format: "%02x", $0) }.joined()
    guard actual == expected else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      publishPinError(for: session, message: "电脑证书指纹不匹配，直连已停止")
      return
    }

    // Trust only the pinned leaf and separately evaluate the SSL hostname/SAN.
    // This permits the QR-authenticated self-signed desktop certificate without
    // disabling hostname verification or changing system trust settings.
    let host = challenge.protectionSpace.host as CFString
    let sslPolicy = SecPolicyCreateSSL(true, host)
    guard SecTrustSetPolicies(trust, sslPolicy) == errSecSuccess,
      SecTrustSetAnchorCertificates(trust, [leaf] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      publishPinError(for: session, message: "电脑证书主机名校验失败，直连已停止")
      return
    }
    var trustError: CFError?
    guard SecTrustEvaluateWithError(trust, &trustError) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      publishPinError(for: session, message: "电脑证书或主机名校验失败，直连已停止")
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask,
                         willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                         completionHandler: @escaping (URLRequest?) -> Void) {
    // A QR pins one exact computer endpoint. Never carry that trust decision
    // across a redirect to another URL, even when the redirected host resolves
    // to the same certificate.
    completionHandler(nil)
  }

  public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                         didOpenWithProtocol protocol: String?) {
    guard isCurrent(generationFor(webSocketTask), webSocketTask) else { return }
    sendEvent("onState", ["state": "open"])
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask,
                         didCompleteWithError error: Error?) {
    guard let socket = task as? URLSessionWebSocketTask else { return }
    let attempt = generationFor(socket)
    guard attempt != 0, isCurrent(attempt, socket) else { return }
    if let error { sendEvent("onError", ["message": errorMessage(error)]) }
    finish(attempt, socket)
  }

  public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                         didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    finish(generationFor(webSocketTask), webSocketTask)
  }

  private func generationFor(_ socket: URLSessionWebSocketTask) -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return task === socket ? generation : 0
  }

  private func publishPinError(for session: URLSession, message: String) {
    lock.lock()
    let current = self.session === session
    lock.unlock()
    if current { sendEvent("onError", ["message": message]) }
  }

  private func errorMessage(_ error: Error) -> String {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorServerCertificateUntrusted {
      return "电脑证书或主机名校验失败，直连已停止"
    }
    return "电脑直连失败：\(error.localizedDescription.prefix(160))"
  }

  private func transportError(_ message: String) -> NSError {
    NSError(domain: "SalcaraDirectTransport", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
