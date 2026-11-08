Pod::Spec.new do |s|
  s.name           = 'SalcaraDirectTransport'
  s.version        = '1.0.0'
  s.summary        = 'Certificate-pinned direct WSS transport for Salcara'
  s.description    = 'A direct-only WebSocket transport with exact certificate and hostname validation'
  s.author         = 'Salcara'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Foundation', 'Security', 'CryptoKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift}"
end
