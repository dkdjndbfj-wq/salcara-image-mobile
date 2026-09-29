/** Speech vendors now live in the single service catalog (src/api/vendors.ts). */
export {
  capabilityOf, KIND_LABEL, VENDORS, vendorById, vendorForService, speechBaseFor, voicesFor,
  type Capability, type RealtimeProtocol, type SpeechKind, type SttProtocol, type TtsProtocol, type Vendor, type VendorField, type VoiceOption,
} from '../api/vendors';
