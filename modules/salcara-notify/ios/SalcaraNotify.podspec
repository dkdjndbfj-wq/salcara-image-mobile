Pod::Spec.new do |s|
  s.name           = 'SalcaraNotify'
  s.version        = '1.0.0'
  s.summary        = 'Local task notifications for Salcara'
  s.description    = 'Local task notifications for Salcara'
  s.author         = 'Salcara'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UserNotifications'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
