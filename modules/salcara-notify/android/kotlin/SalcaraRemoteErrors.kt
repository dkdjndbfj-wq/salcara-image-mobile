package expo.modules.salcaranotify

/** Keep phone pairing distinct from source permission and the computer's enrollment. */
internal fun phonePairingRejected(status: Int, code: String?): Boolean =
  (status == 401 || status == 403) && (code.isNullOrEmpty() || code in setOf(
    "pair_credentials_invalid", "phone_pairing_invalid", "phone_pairing_required", "pairing_invalid", "bot_phone_credentials_invalid", "diagnostic_pairing_invalid"
  ))
